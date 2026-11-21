package helper

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"regexp"
	"strings"
)

// The text of the system prompt for `check.sign`, built HERE from the object that is signed (DESIGN.md 3.3, section 5).
// A port of macos/Sources/UnlockCore/Reason.swift; keep the three (Swift, this, test/fake-helper.mjs reasonFor)
// identical: the tests compare them on the same objects. ALL TEXTS ARE PLACEHOLDERS for the maintainer's wording (O19).
//
// Windows note: Windows Hello does not put "<program> is trying to" in front as macOS does. The text is the same
// verb phrase so all platforms sign the same words; how Windows shows it is to be measured (DESIGN.md section 8).

func quoted(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

const (
	reasonPasskey       = "add a passkey for your Suveren dashboard"
	reasonEnableUnlock  = "turn on Windows Hello unlock for Suveren"
	reasonDisableUnlock = "turn off Windows Hello unlock for Suveren"
	reasonRemove        = "remove a device"
	reasonSetCheck      = "give a device a check key"
	reasonClearCheck    = "remove the check key of a device"
	reasonRotateRoot    = "replace the recovery code"
	reasonCancelReset   = "cancel the request for a new identity"
	reasonTrustAdmin    = "trust the admin of the team you asked to join"
	reasonClearAnchor   = "stop trusting the admin of a team"
	reasonResignList    = "sign the team list again"
)

func reasonGenesis(l string) string      { return "set up the device " + quoted(l) + " with its own key" }
func reasonAdd(l string) string          { return "add the device " + quoted(l) }
func reasonReset(l string) string        { return "replace every device with " + quoted(l) }
func reasonReplaceLogin(n string) string { return "replace the login of " + quoted(n) }
func reasonRemoveLogin(n string) string  { return "remove the login of " + quoted(n) }
func reasonHandOver(n string) string     { return "hand the team over to " + quoted(n) }
func reasonAddMember(n, c string) string { return "add " + quoted(n) + " to the team, code " + c }
func reasonGrant(p string) string        { return "grant the mandate for " + quoted(p) }
func reasonChange(p string) string       { return "change the mandate for " + quoted(p) }
func reasonReplaceMember(n, c string) string {
	return "new identity for " + quoted(n) + ", code " + c
}
func reasonRemoveMember(n, c string) string {
	return "remove " + quoted(n) + " from the team, code " + firstGroups(c)
}

func firstGroups(code string) string {
	parts := strings.Split(code, " ")
	if len(parts) > 4 {
		parts = parts[:4]
	}
	return strings.Join(parts, " ")
}

func set(keys ...string) map[string]bool {
	m := make(map[string]bool, len(keys))
	for _, k := range keys {
		m[k] = true
	}
	return m
}

var (
	changeRequestMembers  = set("request_id", "kind", "name", "change_hash", "gateway_key_id", "expires_at")
	unlockSwitchMembers   = set("typ", "v", "action", "nonce", "issued_at")
	grantFixedMembers     = set("typ", "v", "op", "owner_did", "key_id", "chain_seq", "chain_head", "mandate_id", "mandate_version", "granted_at", "nonce")
	identityCancelMembers = set("typ", "v", "aud", "root_did", "key_id", "request_id", "chain_seq", "chain_head", "issued_at")
	// a dashboard passkey approval (AS step 17): exactly these members, no free text (Reason.swift passkeyRegisterMembers)
	passkeyRegisterMembers = set("typ", "v", "root_did", "key_id", "chain_seq", "chain_head", "request_id", "cred_id", "rp_id", "issued_at")
	anchorMembers          = set("typ", "v", "member_did", "team_id", "admin_did", "version", "prev", "key_id", "chain_seq", "chain_head", "created_at", "nonce")
	memberListMembers      = set("typ", "v", "team_id", "version", "prev", "admin_did", "members", "handover", "key_id", "chain_seq", "chain_head", "created_at", "nonce")
)

func keysEqual(o map[string]any, want map[string]bool) bool {
	if len(o) != len(want) {
		return false
	}
	for k := range o {
		if !want[k] {
			return false
		}
	}
	return true
}

func keysSuperset(o map[string]any, want map[string]bool) bool {
	for k := range want {
		if _, ok := o[k]; !ok {
			return false
		}
	}
	return true
}

var codeRe = regexp.MustCompile(`^[0-9]{4}( [0-9]{4}){5}$`)

func isCode(s string) bool { return codeRe.MatchString(s) }

func parseObject(b []byte) (map[string]any, bool) {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		return nil, false
	}
	// nothing but whitespace may follow the one value (as JSONSerialization refuses trailing data). d.More() is false
	// before a stray '}' or ']', so ask for the next token and require the clean end (security review M6).
	if _, err := d.Token(); err != io.EOF {
		return nil, false
	}
	o, ok := v.(map[string]any)
	return o, ok
}

func asString(v any) (string, bool) { s, ok := v.(string); return s, ok }

func asInt(v any) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	i, err := n.Int64()
	return i, err == nil
}

func isNull(o map[string]any, k string) bool {
	v, present := o[k]
	return present && v == nil
}

// ReasonForObject builds the prompt text from the object's bytes. `focus` picks one member of a member list;
// `previous` is the signed bytes of the member list before this one.
func ReasonForObject(b []byte, focus *string, previous []byte) (string, error) {
	o, ok := parseObject(b)
	if !ok {
		return "", Err("bad_request", "object is not a JSON object.")
	}
	typ, _ := asString(o["typ"])
	if typ == "suveren-chain-entry" {
		return chainEntry(o)
	}
	if keysEqual(o, changeRequestMembers) {
		if name, ok := asString(o["name"]); ok && name != "" {
			switch kind, _ := asString(o["kind"]); kind {
			case "replace":
				return reasonReplaceLogin(name), nil
			case "remove":
				return reasonRemoveLogin(name), nil
			}
		}
	}
	if typ == "suveren-platform-unlock" && keysEqual(o, unlockSwitchMembers) {
		switch a, _ := asString(o["action"]); a {
		case "enable":
			return reasonEnableUnlock, nil
		case "disable":
			return reasonDisableUnlock, nil
		}
	}
	if typ == "suveren-identity-cancel" && keysEqual(o, identityCancelMembers) {
		return reasonCancelReset, nil
	}
	if typ == "suveren-passkey-register" && keysEqual(o, passkeyRegisterMembers) {
		return reasonPasskey, nil
	}
	if typ == "suveren-team-anchor" && keysEqual(o, anchorMembers) {
		if isNull(o, "admin_did") {
			return reasonClearAnchor, nil
		}
		return reasonTrustAdmin, nil
	}
	if typ == "suveren-team-members" && keysEqual(o, memberListMembers) {
		if previous != nil {
			return memberListChange(o, previous, focus)
		}
		if v, ok := asInt(o["version"]); !ok || v != 1 || !isNull(o, "prev") {
			return "", Err("bad_request", "a member list after version 1 needs `previous`.")
		}
		arr, ok := o["members"].([]any)
		if !ok || focus == nil {
			return "", Err("bad_request", "a member list needs a focus that names one of its members.")
		}
		for _, e := range arr {
			m, ok := e.(map[string]any)
			if !ok {
				return "", Err("bad_request", "a member list needs a focus that names one of its members.")
			}
			if did, _ := asString(m["did"]); did == *focus {
				name, nok := asString(m["name"])
				code, cok := asString(m["code"])
				if !nok || name == "" || !cok || !isCode(code) {
					break
				}
				return reasonAddMember(name, code), nil
			}
		}
		return "", Err("bad_request", "a member list needs a focus that names one of its members.")
	}
	if typ == "suveren-mandate-grant" && keysSuperset(o, grantFixedMembers) {
		if profile, ok := asString(o["profile_id"]); ok && profile != "" {
			switch op, _ := asString(o["op"]); op {
			case "grant":
				return reasonGrant(profile), nil
			case "change":
				return reasonChange(profile), nil
			}
		}
	}
	return "", Err("bad_request", "object is of a kind this helper has no prompt text for.")
}

type member struct{ did, name, code string }

func members(o map[string]any) ([]member, error) {
	arr, ok := o["members"].([]any)
	if !ok || len(arr) == 0 {
		return nil, Err("bad_request", "a member list has no members.")
	}
	out := make([]member, 0, len(arr))
	seen := map[string]bool{}
	for _, e := range arr {
		m, ok := e.(map[string]any)
		if !ok {
			return nil, Err("bad_request", "a member of the list is malformed.")
		}
		did, dok := asString(m["did"])
		name, nok := asString(m["name"])
		code, cok := asString(m["code"])
		if !dok || !nok || name == "" || !cok || !isCode(code) {
			return nil, Err("bad_request", "a member of the list is malformed.")
		}
		if seen[did] {
			return nil, Err("bad_request", "a member list names a member twice.")
		}
		seen[did] = true
		out = append(out, member{did, name, code})
	}
	return out, nil
}

func memberListChange(o map[string]any, previous []byte, focus *string) (string, error) {
	p, ok := parseObject(previous)
	if pt, _ := asString(p["typ"]); !ok || pt != "suveren-team-members" || !keysEqual(p, memberListMembers) {
		return "", Err("bad_request", "previous is not a member list.")
	}
	sum := sha256.Sum256(previous)
	digest := "sha256:" + hex.EncodeToString(sum[:])
	if prev, ok := asString(o["prev"]); !ok || prev != digest {
		return "", Err("bad_request", "previous is not the list this one follows.")
	}
	tid, ok1 := asString(o["team_id"])
	ptid, ok2 := asString(p["team_id"])
	v, ok3 := asInt(o["version"])
	pv, ok4 := asInt(p["version"])
	admin, ok5 := asString(o["admin_did"])
	padmin, ok6 := asString(p["admin_did"])
	if !(ok1 && ok2 && ok3 && ok4 && ok5 && ok6) || tid != ptid || v != pv+1 {
		return "", Err("bad_request", "previous is not the version before this list.")
	}
	now, err := members(o)
	if err != nil {
		return "", err
	}
	before, err := members(p)
	if err != nil {
		return "", err
	}
	nowBy := map[string]member{}
	for _, m := range now {
		nowBy[m.did] = m
	}
	beforeBy := map[string]member{}
	for _, m := range before {
		beforeBy[m.did] = m
	}
	if _, ok := nowBy[admin]; !ok {
		return "", Err("bad_request", "the admin is not a member.")
	}
	if _, ok := beforeBy[padmin]; !ok {
		return "", Err("bad_request", "the admin is not a member.")
	}
	var added, removed []member
	for _, m := range now {
		if _, ok := beforeBy[m.did]; !ok {
			added = append(added, m)
		}
	}
	for _, m := range before {
		if _, ok := nowBy[m.did]; !ok {
			removed = append(removed, m)
		}
	}
	for _, m := range now {
		if b, ok := beforeBy[m.did]; ok && (b.name != m.name || b.code != m.code) {
			return "", Err("bad_request", "a member's entry changed.")
		}
	}
	hv, present := o["handover"]
	hasHandover := present && hv != nil
	if admin != padmin {
		h, hok := hv.(map[string]any)
		if len(added) != 0 || len(removed) != 0 || !hasHandover || !hok {
			return "", Err("bad_request", "this change of admin is not a plain hand-over.")
		}
		if hadmin, _ := asString(h["admin_did"]); hadmin != padmin {
			return "", Err("bad_request", "this change of admin is not a plain hand-over.")
		}
		return reasonHandOver(nowBy[admin].name), nil
	}
	if hasHandover {
		return "", Err("bad_request", "a list with the same admin carries no hand-over.")
	}
	if focus != nil && len(added) > 0 {
		found := false
		for _, a := range added {
			if a.did == *focus {
				found = true
			}
		}
		if !found {
			return "", Err("bad_request", "focus is not the added member.")
		}
	}
	switch {
	case len(added) == 0 && len(removed) == 0:
		return reasonResignList, nil
	case len(added) == 1 && len(removed) == 0:
		return reasonAddMember(added[0].name, added[0].code), nil
	case len(added) == 0 && len(removed) == 1:
		if removed[0].did == padmin {
			return "", Err("bad_request", "the admin cannot be removed.")
		}
		return reasonRemoveMember(removed[0].name, removed[0].code), nil
	case len(added) == 1 && len(removed) == 1:
		if removed[0].did == padmin {
			return "", Err("bad_request", "the admin cannot be replaced.")
		}
		return reasonReplaceMember(added[0].name, added[0].code), nil
	}
	return "", Err("bad_request", "this change of the list is not one this helper describes.")
}

func label(o map[string]any) (string, error) {
	d, ok := o["device"].(map[string]any)
	if !ok {
		return "", Err("bad_request", "chain entry has no device label.")
	}
	l, ok := asString(d["label"])
	if !ok {
		return "", Err("bad_request", "chain entry has no device label.")
	}
	return l, nil
}

func chainEntry(o map[string]any) (string, error) {
	op, _ := asString(o["op"])
	switch op {
	case "genesis", "add", "reset":
		l, err := label(o)
		if err != nil {
			return "", err
		}
		switch op {
		case "genesis":
			return reasonGenesis(l), nil
		case "add":
			return reasonAdd(l), nil
		default:
			return reasonReset(l), nil
		}
	case "remove":
		return reasonRemove, nil
	case "set":
		if v, present := o["check"]; !present || v == nil {
			return reasonClearCheck, nil
		}
		return reasonSetCheck, nil
	case "rotate-root":
		return reasonRotateRoot, nil
	}
	return "", Err("bad_request", "chain entry has an unknown op.")
}
