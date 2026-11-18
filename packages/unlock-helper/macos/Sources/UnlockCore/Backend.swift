import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// Who must be present at a key use. Chosen at key creation, stored inside the key
/// (the access control is part of the opaque key blob), reported back to the caller.
public enum Policy: String {
    /// Touch ID, or the Mac's login password when Touch ID is unavailable or fails.
    case userPresence = "user-presence"
    /// Touch ID only; the key dies when a fingerprint is added or removed.
    case biometryCurrentSet = "biometry-current-set"
    /// Touch ID only; survives fingerprint changes.
    case biometryAny = "biometry-any"
}

public struct Capabilities: Equatable {
    public var backend: String          // "secure-enclave"
    public var secureHardware: Bool
    public var biometry: Bool           // a fingerprint is enrolled and usable now
    public var userPresence: Bool       // Touch ID or login password can be asked
}

/// What the person sees. `reason` ends up in the system prompt.
public struct Prompt {
    public var reason: String
    public var interactionAllowed: Bool
    public init(reason: String, interactionAllowed: Bool = true) {
        self.reason = reason; self.interactionAllowed = interactionAllowed
    }
}

public protocol AgreementKey {
    var publicKeyX963: Data { get }
    func sharedSecret(with peer: P256.KeyAgreement.PublicKey) throws -> SharedSecret
}

public protocol SigningKey {
    var publicKeyX963: Data { get }
    /// ECDSA P-256 over SHA-256(message). CryptoKit hashes; `message` is what verifiers hash.
    func sign(_ message: Data) throws -> P256.Signing.ECDSASignature
}

public protocol KeyBackend {
    func capabilities() -> Capabilities
    func createAgreementKey(policy: Policy) throws -> (blob: Data, key: AgreementKey)
    func openAgreementKey(blob: Data, prompt: Prompt) throws -> AgreementKey
    func createSigningKey(policy: Policy) throws -> (blob: Data, key: SigningKey)
    func openSigningKey(blob: Data, prompt: Prompt) throws -> SigningKey
}

// MARK: - Secure Enclave

/// Keys live in the Secure Enclave. The "blob" is CryptoKit's `dataRepresentation`: the key,
/// encrypted to this computer's Secure Enclave, plus its access control. It is not in the
/// keychain, so no keychain-access-group entitlement is needed (DESIGN.md section 8).
public struct SecureEnclaveBackend: KeyBackend {
    public init() {}

    public func capabilities() -> Capabilities {
        var e: NSError?
        let bio = LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &e)
        let owner = LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &e)
        return Capabilities(backend: "secure-enclave", secureHardware: SecureEnclave.isAvailable, biometry: bio, userPresence: owner)
    }

    private func accessControl(_ policy: Policy) throws -> SecAccessControl {
        guard SecureEnclave.isAvailable else { throw HelperError("no_secure_hardware", "This computer has no Secure Enclave.") }
        let caps = capabilities()
        switch policy {
        case .userPresence:
            if !caps.userPresence { throw HelperError("no_secure_hardware", "No Touch ID and no login password to ask.") }
        case .biometryCurrentSet, .biometryAny:
            if !caps.biometry { throw HelperError("no_biometry", "No fingerprint is enrolled, or Touch ID is not available.") }
        }
        let flag: SecAccessControlCreateFlags
        switch policy {
        case .userPresence: flag = .userPresence
        case .biometryCurrentSet: flag = .biometryCurrentSet
        case .biometryAny: flag = .biometryAny
        }
        var cf: Unmanaged<CFError>?
        guard let ac = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, flag], &cf)
        else { throw HelperError("internal", "Access control could not be created.") }
        return ac
    }

    private func context(_ prompt: Prompt) -> LAContext {
        let c = LAContext()
        c.localizedReason = prompt.reason
        c.localizedCancelTitle = "Cancel"
        c.interactionNotAllowed = !prompt.interactionAllowed
        return c
    }

    public func createAgreementKey(policy: Policy) throws -> (blob: Data, key: AgreementKey) {
        let ac = try accessControl(policy)
        do {
            let k = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: ac)
            return (k.dataRepresentation, SEAgreement(inner: k))
        } catch { throw mapError(error, whileOpening: true) }
    }

    public func openAgreementKey(blob: Data, prompt: Prompt) throws -> AgreementKey {
        do {
            let k = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob, authenticationContext: context(prompt))
            return SEAgreement(inner: k)
        } catch { throw mapError(error, whileOpening: true) }
    }

    public func createSigningKey(policy: Policy) throws -> (blob: Data, key: SigningKey) {
        let ac = try accessControl(policy)
        do {
            let k = try SecureEnclave.P256.Signing.PrivateKey(accessControl: ac)
            return (k.dataRepresentation, SESigning(inner: k))
        } catch { throw mapError(error, whileOpening: true) }
    }

    public func openSigningKey(blob: Data, prompt: Prompt) throws -> SigningKey {
        do {
            let k = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context(prompt))
            return SESigning(inner: k)
        } catch { throw mapError(error, whileOpening: true) }
    }
}

private struct SEAgreement: AgreementKey {
    let inner: SecureEnclave.P256.KeyAgreement.PrivateKey
    var publicKeyX963: Data { inner.publicKey.x963Representation }
    func sharedSecret(with peer: P256.KeyAgreement.PublicKey) throws -> SharedSecret {
        do { return try inner.sharedSecretFromKeyAgreement(with: peer) } catch { throw mapError(error, whileOpening: false) }
    }
}

private struct SESigning: SigningKey {
    let inner: SecureEnclave.P256.Signing.PrivateKey
    var publicKeyX963: Data { inner.publicKey.x963Representation }
    func sign(_ message: Data) throws -> P256.Signing.ECDSASignature {
        do { return try inner.signature(for: message) } catch { throw mapError(error, whileOpening: false) }
    }
}

/// Turns the system's refusals into the protocol's codes. Seen on macOS 26.6.2:
/// LocalAuthentication -1004 when interaction is not allowed.
public func mapError(_ error: Error, whileOpening: Bool) -> HelperError {
    if let h = error as? HelperError { return h }
    let ns = error as NSError
    if ns.domain == LAError.errorDomain {
        switch ns.code {
        case LAError.userCancel.rawValue, LAError.systemCancel.rawValue, LAError.appCancel.rawValue, LAError.userFallback.rawValue:
            return HelperError("user_cancelled", "The person cancelled.")
        case LAError.authenticationFailed.rawValue:
            return HelperError("auth_failed", "Touch ID did not recognise the person.")
        case LAError.notInteractive.rawValue:
            return HelperError("interaction_required", "A touch is needed and no prompt may be shown.")
        case LAError.biometryLockout.rawValue:
            return HelperError("biometry_locked", "Touch ID is locked; the Mac's login password unlocks it.")
        case LAError.biometryNotAvailable.rawValue, LAError.biometryNotEnrolled.rawValue:
            return HelperError("no_biometry", "Touch ID is not available.")
        case LAError.passcodeNotSet.rawValue:
            return HelperError("no_secure_hardware", "This Mac has no login password set.")
        default: break
        }
    }
    if ns.domain == NSOSStatusErrorDomain || ns.domain == "com.apple.security" {
        switch ns.code {
        case -128: return HelperError("user_cancelled", "The person cancelled.")
        case -25293: return HelperError("auth_failed", "Touch ID did not recognise the person.")
        case -25308: return HelperError("interaction_required", "A touch is needed and no prompt may be shown.")
        default: break
        }
    }
    // A blob that no longer loads: fingerprints changed under biometry-current-set,
    // the blob came from another computer, or it is damaged.
    if whileOpening { return HelperError("key_invalid", "The key cannot be used on this computer any more.") }
    return HelperError("internal", "The key operation failed (\(ns.domain) \(ns.code)).")
}

#if DEBUG
// MARK: - Software keys (tests and `--backend software` in debug builds only)

/// P-256 keys in memory-and-blob, no hardware and no prompt. Compiled out of release builds, so
/// the shipped helper cannot be told to use it.
public struct SoftwareBackend: KeyBackend {
    public init() {}
    public func capabilities() -> Capabilities {
        // A test double says it can do everything, so the code above it (the gateway's) runs its real paths.
        // The name says what it is; it exists in debug builds only.
        Capabilities(backend: "software-test", secureHardware: true, biometry: true, userPresence: true)
    }
    public func createAgreementKey(policy: Policy) throws -> (blob: Data, key: AgreementKey) {
        let k = P256.KeyAgreement.PrivateKey()
        return (k.rawRepresentation, SWAgreement(inner: k))
    }
    public func openAgreementKey(blob: Data, prompt: Prompt) throws -> AgreementKey {
        guard prompt.interactionAllowed else { throw HelperError("interaction_required", "A touch is needed and no prompt may be shown.") }
        guard let k = try? P256.KeyAgreement.PrivateKey(rawRepresentation: blob) else { throw HelperError("key_invalid", "Bad key blob.") }
        return SWAgreement(inner: k)
    }
    public func createSigningKey(policy: Policy) throws -> (blob: Data, key: SigningKey) {
        let k = P256.Signing.PrivateKey()
        return (k.rawRepresentation, SWSigning(inner: k))
    }
    public func openSigningKey(blob: Data, prompt: Prompt) throws -> SigningKey {
        guard prompt.interactionAllowed else { throw HelperError("interaction_required", "A touch is needed and no prompt may be shown.") }
        guard let k = try? P256.Signing.PrivateKey(rawRepresentation: blob) else { throw HelperError("key_invalid", "Bad key blob.") }
        return SWSigning(inner: k)
    }
}
private struct SWAgreement: AgreementKey {
    let inner: P256.KeyAgreement.PrivateKey
    var publicKeyX963: Data { inner.publicKey.x963Representation }
    func sharedSecret(with peer: P256.KeyAgreement.PublicKey) throws -> SharedSecret { try inner.sharedSecretFromKeyAgreement(with: peer) }
}
private struct SWSigning: SigningKey {
    let inner: P256.Signing.PrivateKey
    var publicKeyX963: Data { inner.publicKey.x963Representation }
    func sign(_ message: Data) throws -> P256.Signing.ECDSASignature { try inner.signature(for: message) }
}
#endif
