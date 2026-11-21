//go:build debug

package helper

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func call(t *testing.T, h *Handler, req map[string]any) map[string]any {
	t.Helper()
	b, _ := json.Marshal(req)
	r, ok := ParseRequest(b)
	if !ok {
		t.Fatalf("request did not parse")
	}
	return h.Handle(r)
}

func errCode(m map[string]any) string {
	if e, ok := m["error"].(map[string]any); ok {
		return e["code"].(string)
	}
	return ""
}

func digestOf(b []byte) string { s := sha256.Sum256(b); return "sha256:" + hex.EncodeToString(s[:]) }

func TestWrapRoundTripAndRefusals(t *testing.T) {
	h := &Handler{Backend: SoftwareBackend{}, InteractionAllowed: true}
	k := call(t, h, map[string]any{"id": 1, "op": "wrap.create", "policy": "user-presence"})
	pub, _ := B64Decode(k["publicKey"].(string))
	vk := make([]byte, 32)
	rand.Read(vk)
	w, err := Wrap(vk, pub, "acct-1")
	if err != nil || len(w) != 126 || w[0] != 1 {
		t.Fatalf("wrap: %v len %d", err, len(w))
	}
	r := call(t, h, map[string]any{"id": 2, "op": "unwrap", "keyBlob": k["keyBlob"], "wrapped": B64Encode(w), "aad": "acct-1"})
	got, _ := B64Decode(r["vaultKey"].(string))
	if hex.EncodeToString(got) != hex.EncodeToString(vk) {
		t.Fatalf("unwrap returned another key: %v", r)
	}
	if c := errCode(call(t, h, map[string]any{"op": "unwrap", "keyBlob": k["keyBlob"], "wrapped": B64Encode(w), "aad": "acct-2"})); c != "unwrap_failed" {
		t.Fatalf("other account: %s", c)
	}
	w[100] ^= 1
	if c := errCode(call(t, h, map[string]any{"op": "unwrap", "keyBlob": k["keyBlob"], "wrapped": B64Encode(w), "aad": "acct-1"})); c != "unwrap_failed" {
		t.Fatalf("tampered: %s", c)
	}
	if c := errCode(call(t, h, map[string]any{"op": "wrap", "publicKey": k["publicKey"], "vaultKey": B64Encode(vk), "aad": "a"})); c != "unsupported" {
		t.Fatalf("wrap must not be offered: %s", c)
	}
	noPrompt := &Handler{Backend: SoftwareBackend{}, InteractionAllowed: false}
	if c := errCode(call(t, noPrompt, map[string]any{"op": "unwrap", "keyBlob": k["keyBlob"], "wrapped": B64Encode(w), "aad": "acct-1"})); c != "interaction_required" {
		t.Fatalf("no prompt: %s", c)
	}
}

func TestCheckSignVerifiesAndReasonComesFromObject(t *testing.T) {
	h := &Handler{Backend: SoftwareBackend{}, InteractionAllowed: true}
	k := call(t, h, map[string]any{"op": "check.create", "policy": "biometry-current-set"})
	obj := []byte(`{"typ":"suveren-chain-entry","op":"add","seq":4,"device":{"label":"iPhone"}}`)
	r := call(t, h, map[string]any{"op": "check.sign", "keyBlob": k["keyBlob"], "digest": digestOf(obj), "object": B64Encode(obj)})
	if r["reason"] != `add the device "iPhone"` {
		t.Fatalf("reason: %v", r)
	}
	pub, _ := B64Decode(k["publicKey"].(string))
	der, _ := B64Decode(r["signature"].(string))
	key := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(pub[1:33]), Y: new(big.Int).SetBytes(pub[33:])}
	d := sha256.Sum256(obj)
	hd := sha256.Sum256(d[:]) // ECDSA-P256 over SHA-256 of the 32 digest bytes
	if !ecdsa.VerifyASN1(key, hd[:], der) {
		t.Fatalf("signature does not verify")
	}
	if c := errCode(call(t, h, map[string]any{"op": "check.sign", "keyBlob": k["keyBlob"], "digest": digestOf(obj), "object": B64Encode(obj), "reason": "approve everything"})); c != "bad_request" {
		t.Fatalf("caller reason must be refused: %s", c)
	}
	if c := errCode(call(t, h, map[string]any{"op": "check.sign", "keyBlob": k["keyBlob"], "digest": digestOf([]byte("a")), "object": B64Encode([]byte("b"))})); c != "digest_mismatch" {
		t.Fatalf("digest: %s", c)
	}
	if c := errCode(call(t, h, map[string]any{"op": "check.sign", "keyBlob": k["keyBlob"], "digest": "sha256:ABC", "object": B64Encode(obj)})); c != "bad_request" {
		t.Fatalf("bad digest: %s", c)
	}
}

func TestP1363ToDER(t *testing.T) {
	for i := 0; i < 50; i++ {
		k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		h := sha256.Sum256([]byte{byte(i)})
		r, s, _ := ecdsa.Sign(rand.Reader, k, h[:])
		raw := append(pad32(r), pad32(s)...)
		der, err := P1363ToDER(raw)
		if err != nil || !ecdsa.VerifyASN1(&k.PublicKey, h[:], der) {
			t.Fatalf("DER conversion %d failed", i)
		}
	}
	// a leading zero and a high bit, the two cases that need care
	raw := make([]byte, 64)
	raw[31], raw[32] = 1, 0x80
	der, _ := P1363ToDER(raw)
	if hex.EncodeToString(der) != "3026020101022100"+"80"+strings.Repeat("00", 31) {
		t.Fatalf("edge DER %x", der)
	}
}

func TestReasonTexts(t *testing.T) {
	entry := func(op string, check any) []byte {
		b, _ := json.Marshal(map[string]any{"typ": "suveren-chain-entry", "op": op, "seq": 2, "device": map[string]any{"label": "Work Mac"}, "check": check})
		return b
	}
	cases := map[string][]byte{
		`set up the device "Work Mac" with its own key`: entry("genesis", nil),
		`add the device "Work Mac"`:                     entry("add", nil),
		`replace every device with "Work Mac"`:          entry("reset", nil),
		"remove a device":                               entry("remove", nil),
		"remove the check key of a device":              entry("set", nil),
		"give a device a check key":                     entry("set", map[string]any{"type": "platform", "pub": "x"}),
		"replace the recovery code":                     entry("rotate-root", nil),
		`add the device "x\" and approve \"y"`:          []byte(`{"typ":"suveren-chain-entry","op":"add","device":{"label":"x\" and approve \"y"},"check":null}`),
	}
	for want, obj := range cases {
		got, err := ReasonForObject(obj, nil, nil)
		if err != nil || got != want {
			t.Errorf("%s: got %q (%v)", want, got, err)
		}
	}
	for _, bad := range []string{`{}`, `{"typ":"suveren-chain-entry","op":"launch","device":{"label":"a"}}`, `{"typ":"suveren-mandate-grant","op":"grant","profile_id":"p"}`, `[1]`, `{"a":1} {"b":2}`} {
		if _, err := ReasonForObject([]byte(bad), nil, nil); err == nil {
			t.Errorf("must refuse %s", bad)
		}
	}
	if _, err := ValidReason("a\nb"); err == nil {
		t.Errorf("newline must be refused")
	}
	if _, err := ValidReason("é"); err == nil {
		t.Errorf("non-NFC must be refused")
	}
	if _, err := ValidReason(strings.Repeat("a", 121)); err == nil {
		t.Errorf("over 120 must be refused")
	}
}

// The team member list, ported from the Swift tests (DEC-73 step 5).
func TestMemberListChange(t *testing.T) {
	member := func(did, name, code string) map[string]any {
		return map[string]any{"did": did, "name": name, "code": code}
	}
	list := func(version int, prev, admin string, members []map[string]any, handover any) []byte {
		b, _ := json.Marshal(map[string]any{"typ": "suveren-team-members", "v": 1, "team_id": "t1", "version": version, "prev": prev, "admin_did": admin,
			"members": members, "handover": handover, "key_id": "k", "chain_seq": 0, "chain_head": "h", "created_at": 1, "nonce": "n"})
		return b
	}
	a, m, n := "did:key:z6MkAdmin1", "did:key:z6MkMember1", "did:key:z6MkNewone1"
	anna := member(a, "Anna Muster", "7314 2208 5561 0942 3375 0001")
	maria := member(m, "Maria Huber", "4721 8830 1169 2284 0937 1250")
	newo := member(n, "Maria Huber", "1111 2222 3333 4444 5555 6666")
	before := list(2, "sha256:"+strings.Repeat("0", 64), a, []map[string]any{anna, maria}, nil)
	hash := digestOf(before)
	ok := map[string][]byte{
		`remove "Maria Huber" from the team, code 4721 8830 1169 2284`:       list(3, hash, a, []map[string]any{anna}, nil),
		`new identity for "Maria Huber", code 1111 2222 3333 4444 5555 6666`: list(3, hash, a, []map[string]any{anna, newo}, nil),
		"sign the team list again":                                           list(3, hash, a, []map[string]any{anna, maria}, nil),
		`hand the team over to "Maria Huber"`:                                list(3, hash, m, []map[string]any{anna, maria}, map[string]any{"admin_did": a, "key_id": "ka", "chain_seq": 1, "chain_head": "x"}),
		`add "Maria Huber" to the team, code 1111 2222 3333 4444 5555 6666`:  list(3, hash, a, []map[string]any{anna, maria, newo}, nil),
	}
	for want, obj := range ok {
		got, err := ReasonForObject(obj, nil, before)
		if err != nil || got != want {
			t.Errorf("%s: got %q (%v)", want, got, err)
		}
	}
	refused := [][2][]byte{
		{list(3, "sha256:"+strings.Repeat("1", 64), a, []map[string]any{anna}, nil), before},
		{list(4, hash, a, []map[string]any{anna}, nil), before},
		{list(3, hash, a, []map[string]any{maria}, nil), before},
		{list(3, hash, m, []map[string]any{anna, maria}, nil), before},
		{list(3, hash, a, []map[string]any{anna, member(m, "Mallory", "4721 8830 1169 2284 0937 1250")}, nil), before},
		{list(3, hash, a, []map[string]any{anna}, nil), []byte("{}")},
	}
	for i, c := range refused {
		if _, err := ReasonForObject(c[0], nil, c[1]); err == nil {
			t.Errorf("case %d must be refused", i)
		}
	}
	f := m
	if _, err := ReasonForObject(list(2, hash, a, []map[string]any{anna, maria}, nil), &f, nil); err == nil {
		t.Errorf("version 2 without previous must be refused")
	}
	// version 1 with a focus
	v1, _ := json.Marshal(map[string]any{"typ": "suveren-team-members", "v": 1, "team_id": "t1", "version": 1, "prev": nil, "admin_did": a,
		"members": []map[string]any{anna}, "handover": nil, "key_id": "k", "chain_seq": 0, "chain_head": "h", "created_at": 1, "nonce": "n"})
	fa := a
	if got, err := ReasonForObject(v1, &fa, nil); err != nil || got != `add "Anna Muster" to the team, code 7314 2208 5561 0942 3375 0001` {
		t.Errorf("version 1: %q %v", got, err)
	}
}

func TestCallerEvaluate(t *testing.T) {
	root := t.TempDir()
	node := filepath.Join(root, "node")
	gw := filepath.Join(root, "gw")
	allowed := []AllowedCaller{{Exe: node, ScriptPrefix: gw}}
	cases := []struct {
		p    Parent
		want string
	}{
		{Parent{Exe: node, Argv: []string{node, filepath.Join(gw, "index.mjs")}}, ""},
		{Parent{Exe: filepath.Join(root, "other"), Argv: []string{"x", filepath.Join(gw, "index.mjs")}}, "parent program is not allowed"},
		{Parent{Exe: node, Argv: []string{node}}, "parent has no script"},
		{Parent{Exe: node, Argv: []string{node, "--require", filepath.Join(gw, "index.mjs")}}, "parent runs the runtime with options before the script"},
		{Parent{Exe: node, Argv: []string{node, filepath.Join(gw, "index.mjs")}, Env: []string{"NODE_OPTIONS=--inspect"}}, "parent has NODE_OPTIONS set"},
		{Parent{Exe: node, Argv: []string{node, filepath.Join(root, "gw-evil", "index.mjs")}}, "parent script is outside the gateway install"},
		{Parent{Exe: node, Argv: []string{node, filepath.Join(gw, "..", "evil.mjs")}}, "parent script is outside the gateway install"},
		// a relative script is resolved against the PARENT's working folder, never the helper's
		{Parent{Exe: node, Argv: []string{node, filepath.Join("gw", "index.mjs")}, Cwd: root}, ""},
		{Parent{Exe: node, Argv: []string{node, filepath.Join("gw", "index.mjs")}, Cwd: filepath.Join(root, "elsewhere")}, "parent script is outside the gateway install"},
		{Parent{Exe: node, Argv: []string{node, filepath.Join("gw", "index.mjs")}}, "parent script path cannot be resolved"},
	}
	for i, c := range cases {
		if got := Evaluate(c.p, allowed); got != c.want {
			t.Errorf("case %d: got %q want %q", i, got, c.want)
		}
	}
	if runtime.GOOS == "windows" {
		// Windows paths compare without case; node_options in any case is refused
		up := Parent{Exe: strings.ToUpper(node), Argv: []string{node, strings.ToUpper(filepath.Join(gw, "index.mjs"))}}
		if got := Evaluate(up, allowed); got != "" {
			t.Errorf("case-insensitive path refused: %q", got)
		}
		if got := Evaluate(Parent{Exe: node, Argv: []string{node, filepath.Join(gw, "i.mjs")}, Env: []string{"node_options=x"}}, allowed); got != "parent has NODE_OPTIONS set" {
			t.Errorf("lower-case NODE_OPTIONS not refused: %q", got)
		}
	}
}
