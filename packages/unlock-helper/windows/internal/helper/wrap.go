package helper

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
)

// The second wrap of the 32-byte vault key (DESIGN.md 3.2). Byte for byte the macOS format (Wrap.swift):
//
//	wrapped = 0x01 || ephemeralPublicKey(65, X9.63) || nonce(12) || ciphertext(32) || tag(16)
//	key     = HKDF-SHA256( ECDH(ephemeral, wrapPublicKey), salt = ephemeralPub || wrapPub,
//	                       info = "suveren-unlock-wrap-v1", 32 bytes )
//	aad     = UTF-8 of the caller's string
//
// The gateway wraps in Node (src/wrap.ts); Wrap exists here for the tests only (the helper has no `wrap` op).
const wrapVersion = 0x01

var wrapInfo = "suveren-unlock-wrap-v1"

func deriveWrapKey(secret, ephemeral, wrapPub []byte) ([]byte, error) {
	salt := append(append([]byte{}, ephemeral...), wrapPub...)
	return hkdf.Key(sha256.New, secret, salt, wrapInfo, 32)
}

// Wrap seals vaultKey to the wrap key's public half. Tests only.
func Wrap(vaultKey, wrapPublicKeyX963 []byte, aad string) ([]byte, error) {
	if len(vaultKey) != 32 {
		return nil, Err("bad_request", "vaultKey must be 32 bytes.")
	}
	pub, err := ecdh.P256().NewPublicKey(wrapPublicKeyX963)
	if err != nil {
		return nil, Err("bad_request", "publicKey is not a P-256 point.")
	}
	eph, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, Err("internal", "No randomness.")
	}
	secret, err := eph.ECDH(pub)
	if err != nil {
		return nil, Err("bad_request", "publicKey is not a P-256 point.")
	}
	ephPub := eph.PublicKey().Bytes()
	k, err := deriveWrapKey(secret, ephPub, wrapPublicKeyX963)
	if err != nil {
		return nil, Err("internal", "Key derivation failed.")
	}
	block, _ := aes.NewCipher(k)
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return nil, Err("internal", "No randomness.")
	}
	out := []byte{wrapVersion}
	out = append(out, ephPub...)
	out = append(out, nonce...)
	return gcm.Seal(out, nonce, vaultKey, []byte(aad)), nil
}

// Unwrap opens a wrap. The key agreement (key.SharedSecret) is where the touch happens.
func Unwrap(wrapped []byte, key AgreementKey, aad string) ([]byte, error) {
	if len(wrapped) != 1+65+60 || wrapped[0] != wrapVersion {
		return nil, Err("unwrap_failed", "Not a wrap this helper made.")
	}
	ephPub := wrapped[1:66]
	body := wrapped[66:]
	peer, err := ecdh.P256().NewPublicKey(ephPub)
	if err != nil {
		return nil, Err("unwrap_failed", "Not a wrap this helper made.")
	}
	secret, err := key.SharedSecret(peer) // touch happens here
	if err != nil {
		return nil, err
	}
	k, err := deriveWrapKey(secret, ephPub, key.PublicKeyX963())
	if err != nil {
		return nil, Err("internal", "Key derivation failed.")
	}
	block, _ := aes.NewCipher(k)
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, body[:12], body[12:], []byte(aad))
	if err != nil || len(plain) != 32 {
		return nil, Err("unwrap_failed", "The wrap does not open here (other key, other account, or damaged).")
	}
	return plain, nil
}
