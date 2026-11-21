package helper

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const (
	ProtocolVersion  = 1
	HelperName       = "suveren-unlock-helper"
	Version          = "0.1.0"
	UnlockReason     = "unlock the Suveren vault"
	MaxReasonScalars = 120
	Platform         = "windows"
)

// Handler is the protocol (DESIGN.md section 3), a port of macos/Sources/UnlockCore/Handler.swift.
type Handler struct {
	Backend            Backend
	InteractionAllowed bool
}

// Handle runs one request. The response always carries the request's id when there was one.
func (h *Handler) Handle(req map[string]any) map[string]any {
	out := map[string]any{}
	if id, ok := req["id"]; ok {
		out["id"] = id
	}
	result, err := h.run(req)
	if err != nil {
		e, ok := err.(*Error)
		if !ok {
			e = Err("internal", "Unexpected failure.")
		}
		out["ok"] = false
		out["error"] = map[string]any{"code": e.Code, "message": e.Message}
		return out
	}
	out["ok"] = true
	for k, v := range result {
		out[k] = v
	}
	return out
}

func (h *Handler) run(r map[string]any) (map[string]any, error) {
	op, ok := r["op"].(string)
	if !ok {
		return nil, Err("bad_request", "op is missing.")
	}
	switch op {
	case "hello":
		c := h.Backend.Capabilities()
		return map[string]any{
			"helper": HelperName, "version": Version, "protocol": ProtocolVersion, "platform": Platform,
			"backend": c.Backend, "secureHardware": c.SecureHardware, "biometry": c.Biometry, "userPresence": c.UserPresence,
		}, nil

	case "wrap.create":
		p, err := policy(r)
		if err != nil {
			return nil, err
		}
		blob, key, err := h.Backend.CreateAgreementKey(p)
		if err != nil {
			return nil, err
		}
		return map[string]any{"keyBlob": B64Encode(blob), "publicKey": B64Encode(key.PublicKeyX963()), "policy": string(p)}, nil

	case "wrap":
		// Not offered: the gateway wraps in Node (DESIGN.md 3.2), so the plaintext vault key never reaches this process.
		return nil, Err("unsupported", "Unknown op wrap.")

	case "unwrap": // one touch
		blob, err := b64(r, "keyBlob")
		if err != nil {
			return nil, err
		}
		wrapped, err := b64(r, "wrapped")
		if err != nil {
			return nil, err
		}
		aad, err := str(r, "aad")
		if err != nil {
			return nil, err
		}
		key, err := h.Backend.OpenAgreementKey(blob, Prompt{Reason: UnlockReason, InteractionAllowed: h.InteractionAllowed})
		if err != nil {
			return nil, err
		}
		vk, err := Unwrap(wrapped, key, aad)
		if err != nil {
			return nil, err
		}
		return map[string]any{"vaultKey": B64Encode(vk)}, nil

	case "check.create":
		p, err := policy(r)
		if err != nil {
			return nil, err
		}
		blob, key, err := h.Backend.CreateSigningKey(p)
		if err != nil {
			return nil, err
		}
		return map[string]any{"keyBlob": B64Encode(blob), "publicKey": B64Encode(key.PublicKeyX963()), "policy": string(p)}, nil

	case "check.sign": // one touch
		digest, err := digestBytes(r)
		if err != nil {
			return nil, err
		}
		// The prompt text comes from the object, never from the caller (DESIGN.md section 5).
		if _, has := r["reason"]; has {
			return nil, Err("bad_request", "reason is not accepted: the helper builds it from the object.")
		}
		os, ok := r["object"].(string)
		if !ok {
			return nil, Err("bad_request", "object must be base64url.")
		}
		obj, ok := B64Decode(os)
		if !ok {
			return nil, Err("bad_request", "object must be base64url.")
		}
		sum := sha256.Sum256(obj)
		if !bytes.Equal(sum[:], digest) {
			return nil, Err("digest_mismatch", "digest is not the SHA-256 of object.")
		}
		var focus *string
		if f, has := r["focus"]; has {
			fs, ok := f.(string)
			if !ok || utf8.RuneCountInString(fs) > 200 {
				return nil, Err("bad_request", "focus must be a DID string.")
			}
			focus = &fs
		}
		var previous []byte
		if pv, has := r["previous"]; has {
			ps, ok := pv.(string)
			pd, dok := B64Decode(ps)
			if !ok || !dok || len(pd) > 200_000 {
				return nil, Err("bad_request", "previous must be base64url.")
			}
			previous = pd
		}
		text, err := ReasonForObject(obj, focus, previous)
		if err != nil {
			return nil, err
		}
		reason, err := ValidReason(text)
		if err != nil {
			return nil, err
		}
		blob, err := b64(r, "keyBlob")
		if err != nil {
			return nil, err
		}
		key, err := h.Backend.OpenSigningKey(blob, Prompt{Reason: reason, InteractionAllowed: h.InteractionAllowed})
		if err != nil {
			return nil, err
		}
		sig, err := key.Sign(digest) // ECDSA over SHA-256(digest bytes); the touch happens here
		if err != nil {
			return nil, err
		}
		return map[string]any{"signature": B64Encode(sig), "publicKey": B64Encode(key.PublicKeyX963()), "reason": reason}, nil

	case "shutdown":
		return map[string]any{}, nil
	}
	return nil, Err("unsupported", "Unknown op "+op+".")
}

func str(r map[string]any, k string) (string, error) {
	s, ok := r[k].(string)
	if !ok {
		return "", Err("bad_request", k+" must be a string.")
	}
	return s, nil
}

func b64(r map[string]any, k string) ([]byte, error) {
	s, err := str(r, k)
	if err != nil {
		return nil, err
	}
	d, ok := B64Decode(s)
	if !ok {
		return nil, Err("bad_request", k+" must be base64url.")
	}
	return d, nil
}

func policy(r map[string]any) (Policy, error) {
	s, err := str(r, "policy")
	if err != nil {
		return "", err
	}
	p, ok := ParsePolicy(s)
	if !ok {
		return "", Err("bad_request", "policy is not one of user-presence, biometry-current-set, biometry-any.")
	}
	return p, nil
}

func digestBytes(r map[string]any) ([]byte, error) {
	s, err := str(r, "digest")
	if err == nil && strings.HasPrefix(s, "sha256:") {
		if d, ok := HexDecode(s[7:]); ok && len(d) == 32 {
			return d, nil
		}
	}
	return nil, Err("bad_request", `digest must be "sha256:" and 64 lower-case hex digits.`)
}

// ValidReason: 1 to 120 characters, NFC, no control, format, line or paragraph separator characters
// (hap-core's device-label rule), so no newline can reshape the prompt.
func ValidReason(s string) (string, error) {
	n := utf8.RuneCountInString(s)
	if n < 1 || n > MaxReasonScalars || !utf8.ValidString(s) {
		return "", Err("bad_request", "reason must be 1 to 120 characters.")
	}
	if !norm.NFC.IsNormalString(s) {
		return "", Err("bad_request", "reason must be NFC.")
	}
	for _, r := range s {
		if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r) {
			return "", Err("bad_request", "reason has a control character.")
		}
	}
	return s, nil
}

// ParseRequest reads one line. Numbers stay json.Number so an `id` comes back exactly as sent.
func ParseRequest(line []byte) (map[string]any, bool) {
	d := json.NewDecoder(bytes.NewReader(line))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		return nil, false
	}
	o, ok := v.(map[string]any)
	return o, ok
}
