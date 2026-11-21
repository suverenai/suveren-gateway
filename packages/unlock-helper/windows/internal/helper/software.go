//go:build debug

package helper

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"math/big"

	"crypto/elliptic"
)

// SoftwareBackend: P-256 keys in memory and in the blob, no hardware and no prompt. For tests only: the command
// selects it only in builds made with `-tags debug` (cmd/.../debug.go), so a release helper cannot be told to use it.
// The name "software-test" is what the release check looks for (bundle/build.mjs refuses a binary that contains it).
type SoftwareBackend struct{}

func (SoftwareBackend) Capabilities() Capabilities {
	// A test double says it can do everything, so the gateway above it runs its real paths.
	return Capabilities{Backend: "software-test", SecureHardware: true, Biometry: true, UserPresence: true}
}

func (SoftwareBackend) CreateAgreementKey(Policy) ([]byte, AgreementKey, error) {
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, Err("internal", "No randomness.")
	}
	return k.Bytes(), swAgreement{k}, nil
}

func (SoftwareBackend) OpenAgreementKey(blob []byte, p Prompt) (AgreementKey, error) {
	if !p.InteractionAllowed {
		return nil, Err("interaction_required", "A touch is needed and no prompt may be shown.")
	}
	k, err := ecdh.P256().NewPrivateKey(blob)
	if err != nil {
		return nil, Err("key_invalid", "Bad key blob.")
	}
	return swAgreement{k}, nil
}

func (SoftwareBackend) CreateSigningKey(Policy) ([]byte, SigningKey, error) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, Err("internal", "No randomness.")
	}
	return pad32(k.D), swSigning{k}, nil
}

func (SoftwareBackend) OpenSigningKey(blob []byte, p Prompt) (SigningKey, error) {
	if !p.InteractionAllowed {
		return nil, Err("interaction_required", "A touch is needed and no prompt may be shown.")
	}
	if len(blob) != 32 {
		return nil, Err("key_invalid", "Bad key blob.")
	}
	// ecdh validates the scalar range; ecdsa wants the big.Int form.
	ek, err := ecdh.P256().NewPrivateKey(blob)
	if err != nil {
		return nil, Err("key_invalid", "Bad key blob.")
	}
	pub := ek.PublicKey().Bytes()
	k := &ecdsa.PrivateKey{
		PublicKey: ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(pub[1:33]), Y: new(big.Int).SetBytes(pub[33:65])},
		D:         new(big.Int).SetBytes(blob),
	}
	return swSigning{k}, nil
}

type swAgreement struct{ k *ecdh.PrivateKey }

func (a swAgreement) PublicKeyX963() []byte { return a.k.PublicKey().Bytes() }
func (a swAgreement) SharedSecret(peer *ecdh.PublicKey) ([]byte, error) {
	s, err := a.k.ECDH(peer)
	if err != nil {
		return nil, Err("unwrap_failed", "Not a wrap this helper made.")
	}
	return s, nil
}

type swSigning struct{ k *ecdsa.PrivateKey }

func (s swSigning) PublicKeyX963() []byte {
	out := []byte{4}
	out = append(out, pad32(s.k.X)...)
	return append(out, pad32(s.k.Y)...)
}

func (s swSigning) Sign(message []byte) ([]byte, error) {
	h := sha256.Sum256(message)
	sig, err := ecdsa.SignASN1(rand.Reader, s.k, h[:])
	if err != nil {
		return nil, Err("internal", "Signing failed.")
	}
	return sig, nil
}
