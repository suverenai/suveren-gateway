//go:build windows

package helper

import (
	"encoding/binary"
	"errors"
	"os"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

// The parent check on Windows (DESIGN.md section 8 "Caller refusal"): the parent's id from a process snapshot, its
// image path from QueryFullProcessImageNameW, its command line from NtQueryInformationProcess and its environment
// from its process parameters (PEB). All from the kernel, nothing from the caller. stdin must be a pipe.

var (
	kernel32                      = syscall.NewLazyDLL("kernel32.dll") // a KnownDLL: always the system's own
	ntdll                         = syscall.NewLazyDLL("ntdll.dll")    // a KnownDLL
	shell32                       = systemDLL("shell32.dll")
	procQueryFullProcessImageName = kernel32.NewProc("QueryFullProcessImageNameW")
	procReadProcessMemory         = kernel32.NewProc("ReadProcessMemory")
	procLocalFree                 = kernel32.NewProc("LocalFree")
	procGetSystemDirectory        = kernel32.NewProc("GetSystemDirectoryW")
	procGetNamedPipeServerPID     = kernel32.NewProc("GetNamedPipeServerProcessId")
	procGetNamedPipeClientPID     = kernel32.NewProc("GetNamedPipeClientProcessId")
	procNtQueryInformationProcess = ntdll.NewProc("NtQueryInformationProcess")
	procCommandLineToArgvW        = shell32.NewProc("CommandLineToArgvW")
)

const (
	processQueryLimitedInformation = 0x1000
	processVMRead                  = 0x0010
	stillActive                    = 259
	fileTypePipe                   = 3
	processBasicInformation        = 0
	processCommandLineInformation  = 60
)

// ParentPID is the id of the process that started this one, from a snapshot of all processes.
func ParentPID() (uint32, error) {
	snap, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0, err
	}
	defer syscall.CloseHandle(snap)
	var e syscall.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	me := uint32(os.Getpid())
	for err = syscall.Process32First(snap, &e); err == nil; err = syscall.Process32Next(snap, &e) {
		if e.ProcessID == me {
			return e.ParentProcessID, nil
		}
	}
	return 0, errors.New("own process not found")
}

// ParentHandle is kept open for the helper's life: the parent's id may be reused only after this handle is closed,
// and its exit code tells whether it is still the same running process.
type ParentHandle struct {
	pid uint32
	h   syscall.Handle
}

func OpenParent(pid uint32) (*ParentHandle, error) {
	h, err := syscall.OpenProcess(processQueryLimitedInformation|processVMRead, false, pid)
	if err != nil {
		return nil, err
	}
	return &ParentHandle{pid: pid, h: h}, nil
}

func (p *ParentHandle) Alive() bool {
	var code uint32
	if syscall.GetExitCodeProcess(p.h, &code) != nil {
		return false
	}
	return code == stillActive
}

func (p *ParentHandle) Image() (string, error) {
	buf := make([]uint16, 32768)
	n := uint32(len(buf))
	r, _, err := procQueryFullProcessImageName.Call(uintptr(p.h), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n)))
	if r == 0 {
		return "", err
	}
	return syscall.UTF16ToString(buf[:n]), nil
}

// CommandLine reads the parent's command line (ProcessCommandLineInformation, Windows 8.1 and later).
func (p *ParentHandle) CommandLine() (string, error) {
	size := uint32(0)
	procNtQueryInformationProcess.Call(uintptr(p.h), processCommandLineInformation, 0, 0, uintptr(unsafe.Pointer(&size)))
	if size == 0 || size > 1<<20 {
		return "", errors.New("command line size")
	}
	buf := make([]byte, size)
	st, _, _ := procNtQueryInformationProcess.Call(uintptr(p.h), processCommandLineInformation, uintptr(unsafe.Pointer(&buf[0])), uintptr(size), uintptr(unsafe.Pointer(&size)))
	if st != 0 {
		return "", errors.New("NtQueryInformationProcess failed")
	}
	// UNICODE_STRING { USHORT Length; USHORT MaximumLength; PWSTR Buffer; } then the characters in the same buffer.
	length := binary.LittleEndian.Uint16(buf[0:2])
	ptr := *(*uintptr)(unsafe.Pointer(&buf[8]))
	base := uintptr(unsafe.Pointer(&buf[0]))
	off := ptr - base
	if ptr < base || off+uintptr(length) > uintptr(len(buf)) {
		return "", errors.New("command line buffer")
	}
	chars := make([]uint16, length/2)
	for i := range chars {
		chars[i] = binary.LittleEndian.Uint16(buf[off+uintptr(2*i):])
	}
	return string(utf16.Decode(chars)), nil
}

// Argv splits a command line the way the C runtime and Node do (CommandLineToArgvW).
func Argv(cmd string) ([]string, error) {
	p, err := syscall.UTF16PtrFromString(cmd)
	if err != nil {
		return nil, err
	}
	var argc int32
	r, _, e := procCommandLineToArgvW.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&argc)))
	if r == 0 {
		return nil, e
	}
	defer procLocalFree.Call(r)
	out := make([]string, argc)
	// r is the LocalAlloc'd array CommandLineToArgvW returned (memory outside Go's heap, freed above).
	base := *(*unsafe.Pointer)(unsafe.Pointer(&r))
	ptrs := unsafe.Slice((**uint16)(base), argc)
	for i, s := range ptrs {
		out[i] = syscall.UTF16ToString(unsafe.Slice(s, 32768)[:wcslen(s)])
	}
	return out, nil
}

func wcslen(p *uint16) int {
	n := 0
	for s := unsafe.Pointer(p); *(*uint16)(s) != 0; s = unsafe.Add(s, 2) {
		n++
	}
	return n
}

func (p *ParentHandle) read(addr uintptr, n int) ([]byte, error) {
	buf := make([]byte, n)
	var got uintptr
	r, _, err := procReadProcessMemory.Call(uintptr(p.h), addr, uintptr(unsafe.Pointer(&buf[0])), uintptr(n), uintptr(unsafe.Pointer(&got)))
	if r == 0 || int(got) != n {
		return nil, err
	}
	return buf, nil
}

// processParameters is the address of the parent's RTL_USER_PROCESS_PARAMETERS (64-bit: PEB+0x20).
func (p *ParentHandle) processParameters() (uintptr, error) {
	var pbi [48]byte // PROCESS_BASIC_INFORMATION: ExitStatus, PebBaseAddress, ...
	var ret uint32
	st, _, _ := procNtQueryInformationProcess.Call(uintptr(p.h), processBasicInformation, uintptr(unsafe.Pointer(&pbi[0])), uintptr(len(pbi)), uintptr(unsafe.Pointer(&ret)))
	if st != 0 {
		return 0, errors.New("basic information")
	}
	peb := uintptr(binary.LittleEndian.Uint64(pbi[8:16]))
	pp, err := p.read(peb+0x20, 8)
	if err != nil {
		return 0, err
	}
	return uintptr(binary.LittleEndian.Uint64(pp)), nil
}

// Cwd reads the parent's working folder (RTL_USER_PROCESS_PARAMETERS+0x38 CurrentDirectory.DosPath, a UNICODE_STRING).
func (p *ParentHandle) Cwd() (string, error) {
	params, err := p.processParameters()
	if err != nil {
		return "", err
	}
	us, err := p.read(params+0x38, 16)
	if err != nil {
		return "", err
	}
	length := int(binary.LittleEndian.Uint16(us[0:2]))
	if length == 0 || length > 65534 || length%2 != 0 {
		return "", errors.New("working folder")
	}
	raw, err := p.read(uintptr(binary.LittleEndian.Uint64(us[8:16])), length)
	if err != nil {
		return "", err
	}
	u := make([]uint16, length/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(raw[2*i:])
	}
	return string(utf16.Decode(u)), nil
}

// Environment reads the parent's environment block from its process parameters (64-bit layout:
// PEB+0x20 ProcessParameters; RTL_USER_PROCESS_PARAMETERS+0x80 Environment, +0x3F0 EnvironmentSize).
// The helper is built only for 64-bit Windows (amd64, arm64), and the gateway's node.exe is 64-bit.
func (p *ParentHandle) Environment() ([]string, error) {
	params, err := p.processParameters()
	if err != nil {
		return nil, err
	}
	envPtr, err := p.read(params+0x80, 8)
	if err != nil {
		return nil, err
	}
	sizeB, err := p.read(params+0x3F0, 8)
	if err != nil {
		return nil, err
	}
	size := binary.LittleEndian.Uint64(sizeB)
	if size == 0 || size > 1<<22 || size%2 != 0 {
		return nil, errors.New("environment size")
	}
	raw, err := p.read(uintptr(binary.LittleEndian.Uint64(envPtr)), int(size))
	if err != nil {
		return nil, err
	}
	u := make([]uint16, size/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(raw[2*i:])
	}
	var out []string
	start := 0
	for i, c := range u {
		if c == 0 {
			if i == start {
				break
			}
			out = append(out, string(utf16.Decode(u[start:i])))
			start = i + 1
		}
	}
	return out, nil
}

// StdinIsPipe: stdin must be the anonymous pipe made by the parent, never a console or a file.
func StdinIsPipe() bool {
	h, err := syscall.GetStdHandle(syscall.STD_INPUT_HANDLE)
	if err != nil {
		return false
	}
	t, err := syscall.GetFileType(h)
	return err == nil && t == fileTypePipe
}

// systemDLL loads a DLL by its full path in the Windows system folder (from the kernel, not the environment), never
// from the helper's own folder: a ncrypt.dll or shell32.dll planted beside the .exe would otherwise be loaded first,
// and the gateway's hash list covers the .exe only (security review M5).
func systemDLL(name string) *syscall.LazyDLL {
	var buf [260]uint16
	n, _, _ := procGetSystemDirectory.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if n == 0 || n >= uintptr(len(buf)) {
		// no system folder known: a path that cannot load, so every use fails closed
		return syscall.NewLazyDLL("\\\\?\\nonexistent\\" + name)
	}
	return syscall.NewLazyDLL(string(utf16.Decode(buf[:n])) + "\\" + name)
}

// StdinPeerIsParent (M1a): the other end of the stdin pipe must belong to the parent. The snapshot's parent id can be
// chosen by whoever creates the process (PROC_THREAD_ATTRIBUTE_PARENT_PROCESS); the pipe's peer cannot. Node gives
// a child a named pipe whose server end it holds, so the server process id is the parent's. Node (libuv) also opens the
// client end itself and hands it down, so the client id is the parent's as well (or this process, for a helper that
// opened it itself); either is accepted, the server must be the parent.
func StdinPeerIsParent(ppid uint32) bool {
	h, err := syscall.GetStdHandle(syscall.STD_INPUT_HANDLE)
	if err != nil {
		return false
	}
	me := uint32(os.Getpid())
	var server, client uint32
	rs, _, _ := procGetNamedPipeServerPID.Call(uintptr(h), uintptr(unsafe.Pointer(&server)))
	rc, _, _ := procGetNamedPipeClientPID.Call(uintptr(h), uintptr(unsafe.Pointer(&client)))
	if rs == 0 || rc == 0 {
		return false
	}
	return server == ppid && (client == ppid || client == me)
}

// CheckParent is the live check, at start and before every request.
func CheckParent(parent *ParentHandle, allowed []AllowedCaller) string {
	if parent == nil || !parent.Alive() {
		return "parent changed or is gone"
	}
	if ppid, err := ParentPID(); err != nil || ppid != parent.pid {
		return "parent changed or is gone"
	}
	if !StdinIsPipe() {
		return "stdin is not a pipe"
	}
	if !StdinPeerIsParent(parent.pid) {
		return "stdin pipe does not lead to the parent"
	}
	exe, err := parent.Image()
	if err != nil {
		return "cannot inspect parent"
	}
	cmd, err := parent.CommandLine()
	if err != nil {
		return "cannot inspect parent"
	}
	argv, err := Argv(cmd)
	if err != nil {
		return "cannot inspect parent"
	}
	env, err := parent.Environment()
	if err != nil {
		return "cannot inspect parent"
	}
	cwd, err := parent.Cwd()
	if err != nil {
		return "cannot inspect parent"
	}
	return Evaluate(Parent{Exe: exe, Argv: argv, Env: env, Cwd: cwd}, allowed)
}
