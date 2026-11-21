//go:build windows

package helper

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"strings"
	"syscall"
	"unsafe"
)

// TPM keys through the Microsoft Platform Crypto Provider (DESIGN.md section 8, Route A): P-256 signing keys
// (the check key) and P-256 key-agreement keys (the unlock wrap key, same ECIES format 0x01 as macOS), persisted by
// Windows under the user's profile, non-exportable. The helper's "blob" is the key's name.
//
// NOT MEASURED. Whether this provider asks for Windows Hello (or the PIN) at EVERY signature and agreement is the
// open, critical point of DESIGN.md section 8. Until a person has run the manual check on a real Windows 11 machine
// with Hello and a TPM 2.0, a release build reports secureHardware=false (the gateway then offers only the password,
// exactly as today) and refuses every key operation. Building with `-tags hellomeasured` turns the TPM path on, for
// that manual check and, once it is passed, for release. A key whose use does not ask the person must never become
// a `platform` check: that is what DEC-47's "grant with a verified check" rests on.

const (
	msPlatformCryptoProvider = "Microsoft Platform Crypto Provider"
	keyNamePrefix            = "suveren-unlock-"
	ncryptUIPolicyProperty   = "UI Policy"
	ncryptUIProtectKeyFlag   = 0x1
	ncryptUIForceHighProtect = 0x2
	bcryptEccPublicBlob      = "ECCPUBLICBLOB"
	bcryptKdfRawSecret       = "TRUNCATE"
	ecdsaP256Magic           = 0x31534345 // BCRYPT_ECDSA_PUBLIC_P256_MAGIC "ECS1"
	ecdhP256Magic            = 0x314B4345 // BCRYPT_ECDH_PUBLIC_P256_MAGIC  "ECK1"
	ncryptSilentFlag         = 0x40
	nteUserCancelled         = 0x80090036
	nteBadKeyset             = 0x80090016
	nteNotFound              = 0x80090011
	nteNotSupported          = 0x80090029
	nteDeviceNotReady        = 0x80090030
	nteSilentContext         = 0x80090022
	scardCancelledByUser     = 0x8010006E
	tpmAuthFail              = 0x80280022
)

var (
	ncrypt                        = syscall.NewLazyDLL("ncrypt.dll")
	procNCryptOpenStorageProvider = ncrypt.NewProc("NCryptOpenStorageProvider")
	procNCryptCreatePersistedKey  = ncrypt.NewProc("NCryptCreatePersistedKey")
	procNCryptSetProperty         = ncrypt.NewProc("NCryptSetProperty")
	procNCryptFinalizeKey         = ncrypt.NewProc("NCryptFinalizeKey")
	procNCryptOpenKey             = ncrypt.NewProc("NCryptOpenKey")
	procNCryptExportKey           = ncrypt.NewProc("NCryptExportKey")
	procNCryptImportKey           = ncrypt.NewProc("NCryptImportKey")
	procNCryptSignHash            = ncrypt.NewProc("NCryptSignHash")
	procNCryptSecretAgreement     = ncrypt.NewProc("NCryptSecretAgreement")
	procNCryptDeriveKey           = ncrypt.NewProc("NCryptDeriveKey")
	procNCryptFreeObject          = ncrypt.NewProc("NCryptFreeObject")
	procNCryptDeleteKey           = ncrypt.NewProc("NCryptDeleteKey")
)

// TPMBackend is the Windows key storage. Measured is false unless built with -tags hellomeasured (measured_*.go).
type TPMBackend struct{}

func status(r uintptr) error {
	if r == 0 {
		return nil
	}
	return mapNcrypt(uint32(r))
}

func mapNcrypt(code uint32) error {
	switch code {
	case nteUserCancelled, scardCancelledByUser:
		return Err("user_cancelled", "The person cancelled.")
	case tpmAuthFail:
		return Err("auth_failed", "Windows Hello did not recognise the person.")
	case nteSilentContext:
		return Err("interaction_required", "A confirmation is needed and no prompt may be shown.")
	case nteBadKeyset, nteNotFound:
		return Err("key_invalid", "The key cannot be used on this computer any more.")
	case nteNotSupported, nteDeviceNotReady:
		return Err("no_secure_hardware", "This computer has no usable TPM.")
	}
	return Err("internal", "The key operation failed (0x"+strings.ToUpper(hex.EncodeToString([]byte{byte(code >> 24), byte(code >> 16), byte(code >> 8), byte(code)}))+").")
}

func utf16p(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }

func openProvider() (uintptr, error) {
	var prov uintptr
	r, _, _ := procNCryptOpenStorageProvider.Call(uintptr(unsafe.Pointer(&prov)), uintptr(unsafe.Pointer(utf16p(msPlatformCryptoProvider))), 0)
	if r != 0 {
		return 0, mapNcrypt(uint32(r))
	}
	return prov, nil
}

func free(h uintptr) {
	if h != 0 {
		procNCryptFreeObject.Call(h)
	}
}

func (TPMBackend) Capabilities() Capabilities {
	if !measured {
		return Capabilities{Backend: "tpm-platform-crypto-unmeasured", SecureHardware: false, Biometry: false, UserPresence: false}
	}
	prov, err := openProvider()
	if err != nil {
		return Capabilities{Backend: "tpm-platform-crypto", SecureHardware: false}
	}
	free(prov)
	// Whether Hello (face or fingerprint) or only the PIN is set up cannot be asked of CNG without a prompt;
	// the provider's own confirmation is the person-check here. Reported as presence, not biometry.
	return Capabilities{Backend: "tpm-platform-crypto", SecureHardware: true, Biometry: false, UserPresence: true}
}

type tpmKey struct {
	name string
	pub  []byte
}

func (k tpmKey) PublicKeyX963() []byte { return k.pub }

func (b TPMBackend) create(alg string, magic uint32, p Policy) ([]byte, tpmKey, error) {
	if !measured {
		return nil, tpmKey{}, Err("no_secure_hardware", "Windows Hello has not been verified for this helper yet; the password stays the way in.")
	}
	if p != PolicyUserPresence {
		// The provider offers one kind of person-check (its UI policy); a "biometry only" key cannot be promised here.
		return nil, tpmKey{}, Err("no_biometry", "This computer's key storage cannot require a fingerprint or face only.")
	}
	prov, err := openProvider()
	if err != nil {
		return nil, tpmKey{}, err
	}
	defer free(prov)
	rnd := make([]byte, 16)
	if _, err := rand.Read(rnd); err != nil {
		return nil, tpmKey{}, Err("internal", "No randomness.")
	}
	name := keyNamePrefix + hex.EncodeToString(rnd)
	var key uintptr
	if r, _, _ := procNCryptCreatePersistedKey.Call(prov, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(utf16p(alg))), uintptr(unsafe.Pointer(utf16p(name))), 0, 0); r != 0 {
		return nil, tpmKey{}, mapNcrypt(uint32(r))
	}
	defer free(key)
	// NCRYPT_UI_POLICY: ask the person at every use of the private key.
	desc := utf16p("Suveren")
	pol := struct {
		version       uint32
		flags         uint32
		creationTitle *uint16
		friendlyName  *uint16
		description   *uint16
	}{1, ncryptUIProtectKeyFlag | ncryptUIForceHighProtect, desc, desc, desc}
	if r, _, _ := procNCryptSetProperty.Call(key, uintptr(unsafe.Pointer(utf16p(ncryptUIPolicyProperty))), uintptr(unsafe.Pointer(&pol)), unsafe.Sizeof(pol), 0); r != 0 {
		procNCryptDeleteKey.Call(key, 0)
		return nil, tpmKey{}, mapNcrypt(uint32(r))
	}
	if r, _, _ := procNCryptFinalizeKey.Call(key, 0); r != 0 {
		procNCryptDeleteKey.Call(key, 0)
		return nil, tpmKey{}, mapNcrypt(uint32(r))
	}
	pub, err := exportPublic(key, magic)
	if err != nil {
		return nil, tpmKey{}, err
	}
	return []byte(name), tpmKey{name: name, pub: pub}, nil
}

// exportPublic: BCRYPT_ECCKEY_BLOB { ULONG dwMagic; ULONG cbKey; } X || Y → 0x04 || X || Y.
func exportPublic(key uintptr, magic uint32) ([]byte, error) {
	buf := make([]byte, 8+64)
	var n uint32
	if r, _, _ := procNCryptExportKey.Call(key, 0, uintptr(unsafe.Pointer(utf16p(bcryptEccPublicBlob))), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), uintptr(unsafe.Pointer(&n)), 0); r != 0 {
		return nil, mapNcrypt(uint32(r))
	}
	if n != 72 || binary.LittleEndian.Uint32(buf[0:4]) != magic || binary.LittleEndian.Uint32(buf[4:8]) != 32 {
		return nil, Err("internal", "The public key has an unexpected form.")
	}
	return append([]byte{4}, buf[8:72]...), nil
}

func (b TPMBackend) open(blob []byte, magic uint32, prompt Prompt) (uintptr, uintptr, tpmKey, error) {
	if !measured {
		return 0, 0, tpmKey{}, Err("no_secure_hardware", "Windows Hello has not been verified for this helper yet; the password stays the way in.")
	}
	name := string(blob)
	if !strings.HasPrefix(name, keyNamePrefix) || len(name) != len(keyNamePrefix)+32 {
		return 0, 0, tpmKey{}, Err("key_invalid", "Bad key blob.")
	}
	prov, err := openProvider()
	if err != nil {
		return 0, 0, tpmKey{}, err
	}
	var key uintptr
	flags := uintptr(0)
	if !prompt.InteractionAllowed {
		flags = ncryptSilentFlag
	}
	if r, _, _ := procNCryptOpenKey.Call(prov, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(utf16p(name))), 0, flags); r != 0 {
		free(prov)
		return 0, 0, tpmKey{}, mapNcrypt(uint32(r))
	}
	pub, err := exportPublic(key, magic)
	if err != nil {
		free(key)
		free(prov)
		return 0, 0, tpmKey{}, err
	}
	return prov, key, tpmKey{name: name, pub: pub}, nil
}

// --- signing (check key)

type tpmSigning struct {
	tpmKey
	prompt Prompt
}

func (b TPMBackend) CreateSigningKey(p Policy) ([]byte, SigningKey, error) {
	blob, k, err := b.create("ECDSA_P256", ecdsaP256Magic, p)
	if err != nil {
		return nil, nil, err
	}
	return blob, tpmSigning{tpmKey: k, prompt: Prompt{InteractionAllowed: true}}, nil
}

func (b TPMBackend) OpenSigningKey(blob []byte, prompt Prompt) (SigningKey, error) {
	prov, key, k, err := b.open(blob, ecdsaP256Magic, prompt)
	if err != nil {
		return nil, err
	}
	free(key)
	free(prov)
	return tpmSigning{tpmKey: k, prompt: prompt}, nil
}

// Sign: ECDSA-P256 over SHA-256(message). CNG signs a hash, so the helper hashes first; the result is P1363 r||s,
// turned into DER like the macOS helper returns. The person is asked here.
func (s tpmSigning) Sign(message []byte) ([]byte, error) {
	prov, key, _, err := TPMBackend{}.open([]byte(s.name), ecdsaP256Magic, s.prompt)
	if err != nil {
		return nil, err
	}
	defer free(prov)
	defer free(key)
	h := sha256Sum(message)
	sig := make([]byte, 64)
	var n uint32
	flags := uintptr(0)
	if !s.prompt.InteractionAllowed {
		flags = ncryptSilentFlag
	}
	if r, _, _ := procNCryptSignHash.Call(key, 0, uintptr(unsafe.Pointer(&h[0])), 32, uintptr(unsafe.Pointer(&sig[0])), 64, uintptr(unsafe.Pointer(&n)), flags); r != 0 {
		return nil, mapNcrypt(uint32(r))
	}
	if n != 64 {
		return nil, Err("internal", "Signature has the wrong length.")
	}
	return P1363ToDER(sig)
}

// --- key agreement (unlock wrap key)

type tpmAgreement struct {
	tpmKey
	prompt Prompt
}

func (b TPMBackend) CreateAgreementKey(p Policy) ([]byte, AgreementKey, error) {
	blob, k, err := b.create("ECDH_P256", ecdhP256Magic, p)
	if err != nil {
		return nil, nil, err
	}
	return blob, tpmAgreement{tpmKey: k, prompt: Prompt{InteractionAllowed: true}}, nil
}

func (b TPMBackend) OpenAgreementKey(blob []byte, prompt Prompt) (AgreementKey, error) {
	prov, key, k, err := b.open(blob, ecdhP256Magic, prompt)
	if err != nil {
		return nil, err
	}
	free(key)
	free(prov)
	return tpmAgreement{tpmKey: k, prompt: prompt}, nil
}

// SharedSecret: the ECDH X coordinate, big-endian (CNG's raw secret is little-endian). The person is asked here.
func (a tpmAgreement) SharedSecret(peer *ecdh.PublicKey) ([]byte, error) {
	prov, key, _, err := TPMBackend{}.open([]byte(a.name), ecdhP256Magic, a.prompt)
	if err != nil {
		return nil, err
	}
	defer free(prov)
	defer free(key)
	pb := peer.Bytes() // 0x04 || X || Y
	blob := make([]byte, 8+64)
	binary.LittleEndian.PutUint32(blob[0:4], ecdhP256Magic)
	binary.LittleEndian.PutUint32(blob[4:8], 32)
	copy(blob[8:], pb[1:])
	var hPeer uintptr
	if r, _, _ := procNCryptImportKey.Call(prov, 0, uintptr(unsafe.Pointer(utf16p(bcryptEccPublicBlob))), 0, uintptr(unsafe.Pointer(&hPeer)), uintptr(unsafe.Pointer(&blob[0])), uintptr(len(blob)), 0); r != 0 {
		return nil, Err("unwrap_failed", "Not a wrap this helper made.")
	}
	defer free(hPeer)
	var hSecret uintptr
	flags := uintptr(0)
	if !a.prompt.InteractionAllowed {
		flags = ncryptSilentFlag
	}
	if r, _, _ := procNCryptSecretAgreement.Call(key, hPeer, uintptr(unsafe.Pointer(&hSecret)), flags); r != 0 {
		return nil, mapNcrypt(uint32(r))
	}
	defer free(hSecret)
	out := make([]byte, 32)
	var n uint32
	if r, _, _ := procNCryptDeriveKey.Call(hSecret, uintptr(unsafe.Pointer(utf16p(bcryptKdfRawSecret))), 0, uintptr(unsafe.Pointer(&out[0])), 32, uintptr(unsafe.Pointer(&n)), 0); r != 0 {
		return nil, mapNcrypt(uint32(r))
	}
	if n != 32 {
		return nil, Err("internal", "The shared secret has the wrong length.")
	}
	for i, j := 0, 31; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}
