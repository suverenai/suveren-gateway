package helper

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// AllowedCaller is one entry of allowed-callers.json beside the helper:
// {"v":1,"callers":[{"exe":"C:\\...\\node.exe","scriptPrefix":"C:\\...\\control-plane"}]} (DESIGN.md section 4).
type AllowedCaller struct {
	Exe          string
	ScriptPrefix string
}

// LoadAllowed reads the list. Any doubt refuses (the caller is then not served).
func LoadAllowed(path string) ([]AllowedCaller, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, Err("caller_refused", "No readable allowed-callers.json next to the helper.")
	}
	var f struct {
		V       int `json:"v"`
		Callers []struct {
			Exe          *string `json:"exe"`
			ScriptPrefix *string `json:"scriptPrefix"`
		} `json:"callers"`
	}
	if json.Unmarshal(b, &f) != nil || f.V != 1 || len(f.Callers) == 0 {
		return nil, Err("caller_refused", "No readable allowed-callers.json next to the helper.")
	}
	out := make([]AllowedCaller, 0, len(f.Callers))
	for _, c := range f.Callers {
		if c.Exe == nil || c.ScriptPrefix == nil || !filepath.IsAbs(*c.Exe) || !filepath.IsAbs(*c.ScriptPrefix) {
			return nil, Err("caller_refused", "allowed-callers.json entries need absolute exe and scriptPrefix.")
		}
		out = append(out, AllowedCaller{Exe: *c.Exe, ScriptPrefix: *c.ScriptPrefix})
	}
	return out, nil
}

// Parent is what the operating system says about the process that started the helper (never what the caller sends).
type Parent struct {
	Exe  string
	Argv []string
	Env  []string
	// Cwd is the parent's working folder: a script given by a relative path is resolved against it.
	Cwd string
}

// Resolve gives a path in a comparable form: absolute, cleaned, links followed where possible.
// pathEqual and pathHasPrefix compare without case on Windows (pathfold_*.go).
func Resolve(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	if a, err := filepath.Abs(p); err == nil {
		p = a
	}
	return filepath.Clean(p)
}

// Evaluate is the pure decision. "" = accepted, otherwise the reason (for the log, never for the caller).
func Evaluate(parent Parent, allowed []AllowedCaller) string {
	exe := Resolve(parent.Exe)
	var rule *AllowedCaller
	for i := range allowed {
		if pathEqual(Resolve(allowed[i].Exe), exe) {
			rule = &allowed[i]
			break
		}
	}
	if rule == nil {
		return "parent program is not allowed"
	}
	if len(parent.Argv) < 2 {
		return "parent has no script"
	}
	script := parent.Argv[1]
	if strings.HasPrefix(script, "-") {
		return "parent runs the runtime with options before the script"
	}
	for _, e := range parent.Env {
		if hasPrefixFold(e, "NODE_OPTIONS=") {
			return "parent has NODE_OPTIONS set"
		}
	}
	if !filepath.IsAbs(script) {
		if parent.Cwd == "" || !filepath.IsAbs(parent.Cwd) {
			return "parent script path cannot be resolved"
		}
		script = filepath.Join(parent.Cwd, script)
	}
	base := Resolve(rule.ScriptPrefix)
	s := Resolve(script)
	sep := string(filepath.Separator)
	if !pathEqual(s, base) && !pathHasPrefix(s, strings.TrimSuffix(base, sep)+sep) {
		return "parent script is outside the gateway install"
	}
	return ""
}
