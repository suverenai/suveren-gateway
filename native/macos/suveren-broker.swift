// suveren-broker: lets only the genuine Suveren agent talk to the gateway daemon.
//
// The daemon (Node) cannot ask the kernel which program is on the other end of a
// Unix socket. This small program can: for every connection it reads the peer's
// audit token, asks the system whether that code satisfies the pinned requirement
// (identifier + cdhash of the installed agent, written by the installer into a
// root-owned file), and only then passes messages on. It runs as a child of the
// daemon, as the daemon's account.
//
//   suveren-broker --socket <path> --pin <pin.json>
//
// Daemon -> broker (stdin, one JSON object per line):
//   {"conn": 3, "data": {...}}     send to connection 3
//   {"conn": 3, "close": true}     close connection 3
// Broker -> daemon (stdout, one JSON object per line):
//   {"event":"ready"}
//   {"event":"open","conn":3}  {"event":"msg","conn":3,"msg":{...}}  {"event":"close","conn":3}
//   {"event":"refused","verdict":"..."}      a peer that failed the check; never reaches the daemon otherwise
// The broker exits when its stdin closes (the daemon is gone).
import Foundation
import Security

let maxLine = 65536

func die(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(2) }

// ─── pinned requirement ────────────────────────────────────────────────
func loadRequirement(_ pinPath: String) -> String {
    guard let data = FileManager.default.contents(atPath: pinPath),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let ident = obj["identifier"] as? String, let hash = obj["cdhash"] as? String else { die("pin file unreadable") }
    // Strict: these go into a requirement string.
    guard ident.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$", options: .regularExpression) != nil else { die("bad identifier in pin") }
    guard hash.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil else { die("bad cdhash in pin") }
    return "identifier \"\(ident)\" and cdhash H\"\(hash)\""
}

// ─── the check ─────────────────────────────────────────────────────────
func verdict(_ fd: Int32, _ requirement: SecRequirement) -> (ok: Bool, text: String) {
    var tok = audit_token_t(); var tlen = socklen_t(MemoryLayout<audit_token_t>.size)
    if getsockopt(fd, 0 /*SOL_LOCAL*/, 6 /*LOCAL_PEERTOKEN*/, &tok, &tlen) != 0 { return (false, "no peer token") }
    let tokData = Data(bytes: &tok, count: MemoryLayout<audit_token_t>.size)
    var code: SecCode?
    let st = SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributeAudit: tokData] as CFDictionary, [], &code)
    guard st == errSecSuccess, let c = code else { return (false, "no code object (unsigned program)") }
    let chk = SecCodeCheckValidity(c, [], requirement)
    return chk == errSecSuccess ? (true, "accepted") : (false, "requirement not met (status \(chk))")
}

// ─── plumbing ──────────────────────────────────────────────────────────
let outLock = NSLock()
func emit(_ obj: [String: Any]) {
    guard var d = try? JSONSerialization.data(withJSONObject: obj) else { return }
    d.append(10)
    outLock.lock(); FileHandle.standardOutput.write(d); outLock.unlock()
}
let connLock = NSLock()
var conns: [Int: Int32] = [:]
var nextId = 1

func writeAll(_ fd: Int32, _ data: Data) {
    data.withUnsafeBytes { p in
        var off = 0
        while off < data.count { let n = write(fd, p.baseAddress! + off, data.count - off); if n <= 0 { return }; off += n }
    }
}

func readLines(_ fd: Int32, _ onLine: (Data) -> Bool) {
    var buf = Data()
    var chunk = [UInt8](repeating: 0, count: 4096)
    while true {
        let n = read(fd, &chunk, chunk.count)
        if n <= 0 { return }
        buf.append(chunk, count: n)
        while let i = buf.firstIndex(of: 10) {
            let line = buf.subdata(in: buf.startIndex..<i)
            buf.removeSubrange(buf.startIndex...i)
            if !onLine(line) { return }
        }
        if buf.count > maxLine { return }
    }
}

// ─── main ──────────────────────────────────────────────────────────────
var socketPath = "", pinPath = ""
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
    let k = args.removeFirst()
    guard !args.isEmpty else { die("usage: suveren-broker --socket <path> --pin <pin.json>") }
    let v = args.removeFirst()
    if k == "--socket" { socketPath = v } else if k == "--pin" { pinPath = v } else { die("unknown option \(k)") }
}
guard !socketPath.isEmpty, !pinPath.isEmpty else { die("usage: suveren-broker --socket <path> --pin <pin.json>") }
var req: SecRequirement?
guard SecRequirementCreateWithString(loadRequirement(pinPath) as CFString, [], &req) == errSecSuccess, let requirement = req else { die("bad requirement") }

signal(SIGPIPE, SIG_IGN)
// A plain SIGTERM must also remove the socket.
signal(SIGTERM, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
termSource.setEventHandler { unlink(socketPath); exit(0) }
termSource.resume()
unlink(socketPath)
let s = socket(AF_UNIX, SOCK_STREAM, 0)
var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
let pathBytes = Array(socketPath.utf8) + [0]
guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { die("socket path too long") }
withUnsafeMutableBytes(of: &addr.sun_path) { p in for i in 0..<pathBytes.count { p[i] = pathBytes[i] } }
let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
guard bound == 0 else { die("bind failed (errno \(errno))") }
// Anyone may connect (the person's agent is another user); the check above decides who is served.
chmod(socketPath, 0o666)
listen(s, 8)

// Daemon -> clients, on its own thread. EOF on stdin = the daemon is gone.
Thread.detachNewThread {
    readLines(0) { line in
        guard let o = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any], let id = o["conn"] as? Int else { return true }
        connLock.lock(); let fd = conns[id]; connLock.unlock()
        guard let fd = fd else { return true }
        if o["close"] as? Bool == true { shutdown(fd, SHUT_RDWR); return true }
        if let data = o["data"], var d = try? JSONSerialization.data(withJSONObject: data) { d.append(10); writeAll(fd, d) }
        return true
    }
    unlink(socketPath); exit(0)
}

emit(["event": "ready"])
while true {
    let c = accept(s, nil, nil)
    if c < 0 { continue }
    let v = verdict(c, requirement)
    if !v.ok {
        writeAll(c, Data("{\"error\":\"refused\"}\n".utf8)); close(c)
        emit(["event": "refused", "verdict": v.text]); continue
    }
    connLock.lock(); let id = nextId; nextId += 1; conns[id] = c; connLock.unlock()
    emit(["event": "open", "conn": id])
    Thread.detachNewThread {
        readLines(c) { line in
            guard let m = try? JSONSerialization.jsonObject(with: line) else { return false }
            emit(["event": "msg", "conn": id, "msg": m]); return true
        }
        connLock.lock(); conns[id] = nil; connLock.unlock()
        close(c); emit(["event": "close", "conn": id])
    }
}
