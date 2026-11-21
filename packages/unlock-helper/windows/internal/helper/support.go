// Package helper is the protocol of the native unlock helper (packages/unlock-helper/DESIGN.md section 3),
// without the I/O and without any Windows API: one request in, one response out. It mirrors the macOS helper
// (macos/Sources/UnlockCore) line for line, so the gateway's Node client talks to both the same way and the
// tests can compare the two on the same objects.
package helper

import (
	"encoding/base64"
	"encoding/hex"
	"regexp"
	"strings"
)

// Error is a refusal the gateway can act on. Code is part of the protocol (DESIGN.md 3.4).
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Err builds a protocol error.
func Err(code, message string) *Error { return &Error{Code: code, Message: message} }

var b64urlAlphabet = regexp.MustCompile(`^[A-Za-z0-9_-]*$`)

// B64Encode is base64url without padding.
func B64Encode(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// B64Decode is strict about the alphabet and padding (as the macOS helper): only the base64url alphabet, no padding,
// and never a length of 1 modulo 4.
func B64Decode(s string) ([]byte, bool) {
	if !b64urlAlphabet.MatchString(s) || len(s)%4 == 1 {
		return nil, false
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, false
	}
	return b, true
}

var lowerHex = regexp.MustCompile(`^[0-9a-f]*$`)

// HexDecode accepts lower-case hex only, as the macOS helper does.
func HexDecode(s string) ([]byte, bool) {
	if len(s)%2 != 0 || !lowerHex.MatchString(s) {
		return nil, false
	}
	b, err := hex.DecodeString(s)
	return b, err == nil
}

func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
}
