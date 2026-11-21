package helper

import "crypto/ecdh"

// Policy is who must be present at a key use (DESIGN.md 6.1). The names are the protocol's; on Windows the
// three map onto what the key storage offers (backend_windows.go), and a policy the backend cannot honour is refused.
type Policy string

const (
	PolicyUserPresence       Policy = "user-presence"
	PolicyBiometryCurrentSet Policy = "biometry-current-set"
	PolicyBiometryAny        Policy = "biometry-any"
)

// ParsePolicy accepts only the three names of the protocol.
func ParsePolicy(s string) (Policy, bool) {
	switch Policy(s) {
	case PolicyUserPresence, PolicyBiometryCurrentSet, PolicyBiometryAny:
		return Policy(s), true
	}
	return "", false
}

// Capabilities is what `hello` reports.
type Capabilities struct {
	Backend        string
	SecureHardware bool
	Biometry       bool
	UserPresence   bool
}

// Prompt is what the person is shown. Reason is always built by this helper (from the object, or the fixed unlock text).
type Prompt struct {
	Reason             string
	InteractionAllowed bool
}

// AgreementKey is a P-256 key agreement private key held by the backend. The touch happens in SharedSecret.
type AgreementKey interface {
	PublicKeyX963() []byte
	// SharedSecret returns the X coordinate of the ECDH point, big-endian, 32 bytes (what CryptoKit's SharedSecret holds).
	SharedSecret(peer *ecdh.PublicKey) ([]byte, error)
}

// SigningKey is a P-256 ECDSA key held by the backend. The touch happens in Sign.
type SigningKey interface {
	PublicKeyX963() []byte
	// Sign returns the DER signature of ECDSA-P256 over SHA-256(message).
	Sign(message []byte) ([]byte, error)
}

// Backend holds the keys. The "blob" is opaque to everyone but the backend.
type Backend interface {
	Capabilities() Capabilities
	CreateAgreementKey(p Policy) (blob []byte, key AgreementKey, err error)
	OpenAgreementKey(blob []byte, prompt Prompt) (AgreementKey, error)
	CreateSigningKey(p Policy) (blob []byte, key SigningKey, err error)
	OpenSigningKey(blob []byte, prompt Prompt) (SigningKey, error)
}
