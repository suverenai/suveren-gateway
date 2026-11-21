// suveren-unlock-helper serve (Windows)
//
// One JSON request per line on stdin, one JSON response per line on stdout; stderr: one short line on refusal, never
// a secret. Exits when stdin closes or its parent changes. The same protocol as the macOS helper (DESIGN.md section 3).
//
// Debug builds only (`go build -tags debug`; tests, never shipped): --backend software, --allow-any-caller,
// --allowed-callers <file>. A release build reads allowed-callers.json beside its own .exe and nothing else.
// SUVEREN_HELPER_NO_PROMPT=1 makes every person-check fail with interaction_required (it only restricts).
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/suverenai/suveren-gateway/packages/unlock-helper/windows/internal/helper"
)

const maxLine = 16384

func logf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "suveren-unlock-helper: "+format+"\n", a...)
}

func emit(w *bufio.Writer, o map[string]any) {
	b, err := json.Marshal(o) // map keys come out sorted, as the macOS helper's .sortedKeys
	if err != nil {
		return
	}
	w.Write(b)
	w.WriteByte('\n')
	w.Flush()
}

func main() {
	args := os.Args[1:]
	if len(args) == 0 || args[0] != "serve" {
		logf("usage: suveren-unlock-helper serve")
		os.Exit(64)
	}
	opts := parseOptions(args[1:]) // debug.go / release.go

	var backend helper.Backend = defaultBackend()
	if opts.softwareBackend {
		backend = softwareBackend()
	}

	var parent *helper.ParentHandle
	var allowed []helper.AllowedCaller
	if !opts.allowAnyCaller {
		me, err := os.Executable()
		if err != nil {
			logf("refused: cannot find itself")
			os.Exit(77)
		}
		file := filepath.Join(filepath.Dir(helper.Resolve(me)), "allowed-callers.json")
		if opts.allowedCallers != "" {
			file = opts.allowedCallers
		}
		allowed, err = helper.LoadAllowed(file)
		if err != nil {
			logf("refused: no caller list")
			os.Exit(77)
		}
		ppid, err := helper.ParentPID()
		if err == nil {
			parent, err = helper.OpenParent(ppid)
		}
		if err != nil {
			logf("refused: cannot inspect parent")
			os.Exit(77)
		}
		if why := helper.CheckParent(parent, allowed); why != "" {
			logf("refused: %s", why)
			os.Exit(77)
		}
	}

	h := &helper.Handler{Backend: backend, InteractionAllowed: os.Getenv("SUVEREN_HELPER_NO_PROMPT") != "1"}
	in := bufio.NewReaderSize(os.Stdin, maxLine+2)
	out := bufio.NewWriter(os.Stdout)
	for {
		line, tooLong, err := readLine(in)
		if err != nil {
			return // stdin closed: the gateway is gone
		}
		if !opts.allowAnyCaller {
			if why := helper.CheckParent(parent, allowed); why != "" {
				emit(out, map[string]any{"ok": false, "error": map[string]any{"code": "caller_refused", "message": "The caller is not the gateway."}})
				logf("refused: %s", why)
				os.Exit(77)
			}
		}
		if tooLong {
			emit(out, map[string]any{"ok": false, "error": map[string]any{"code": "bad_request", "message": "Request too large."}})
			continue
		}
		req, ok := helper.ParseRequest(line)
		if !ok {
			emit(out, map[string]any{"ok": false, "error": map[string]any{"code": "bad_request", "message": "Not a JSON object."}})
			continue
		}
		emit(out, h.Handle(req))
		if op, _ := req["op"].(string); op == "shutdown" {
			os.Exit(0)
		}
	}
}

// readLine returns one line without its end (\n or \r\n). A line over 16 KiB is read to its end and reported.
func readLine(r *bufio.Reader) ([]byte, bool, error) {
	var buf []byte
	tooLong := false
	for {
		chunk, isPrefix, err := r.ReadLine()
		if err != nil {
			if len(buf) > 0 || tooLong {
				return buf, tooLong, nil
			}
			return nil, false, err
		}
		if !tooLong {
			buf = append(buf, chunk...)
			if len(buf) > maxLine {
				tooLong, buf = true, nil
			}
		}
		if !isPrefix {
			return buf, tooLong, nil
		}
	}
}
