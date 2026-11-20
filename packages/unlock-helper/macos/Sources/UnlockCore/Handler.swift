import CryptoKit
import Foundation

/// The protocol, without the I/O. One request in, one response out. DESIGN.md section 3.
public final class Handler {
    public static let protocolVersion = 1
    public static let helperName = "suveren-unlock-helper"
    public static let version = "0.1.0"
    /// What the system prompt says for an unlock. Fixed here, never taken from the caller.
    public static let unlockReason = "unlock the Suveren vault"
    public static let maxReasonScalars = 120

    let backend: KeyBackend
    let interactionAllowed: Bool

    public init(backend: KeyBackend, interactionAllowed: Bool = true) {
        self.backend = backend
        self.interactionAllowed = interactionAllowed
    }

    public func handle(_ req: [String: Any]) -> [String: Any] {
        var out: [String: Any] = [:]
        if let id = req["id"] { out["id"] = id }
        do {
            guard let op = req["op"] as? String else { throw HelperError("bad_request", "op is missing.") }
            let result = try run(op, req)
            out["ok"] = true
            for (k, v) in result { out[k] = v }
        } catch let e as HelperError {
            out["ok"] = false
            out["error"] = ["code": e.code, "message": e.message]
        } catch {
            out["ok"] = false
            out["error"] = ["code": "internal", "message": "Unexpected failure."]
        }
        return out
    }

    private func run(_ op: String, _ r: [String: Any]) throws -> [String: Any] {
        switch op {
        case "hello":
            let c = backend.capabilities()
            return [
                "helper": Handler.helperName, "version": Handler.version, "protocol": Handler.protocolVersion,
                "platform": "macos", "backend": c.backend,
                "secureHardware": c.secureHardware, "biometry": c.biometry, "userPresence": c.userPresence,
            ]

        case "wrap.create":
            let (blob, key) = try backend.createAgreementKey(policy: try policy(r))
            return ["keyBlob": Base64URL.encode(blob), "publicKey": Base64URL.encode(key.publicKeyX963), "policy": try policy(r).rawValue]

        case "wrap":
            // Not offered: the gateway wraps in Node (DESIGN.md 3.2), so the plaintext vault key never reaches this process.
            throw HelperError("unsupported", "Unknown op wrap.")

        case "unwrap":    // one touch
            let blob = try b64(r, "keyBlob"), wrapped = try b64(r, "wrapped")
            let key = try backend.openAgreementKey(blob: blob, prompt: Prompt(reason: Handler.unlockReason, interactionAllowed: interactionAllowed))
            let vk = try Wrap.unwrap(wrapped: wrapped, key: key, aad: try str(r, "aad"))
            return ["vaultKey": Base64URL.encode(vk)]

        case "check.create":
            let p = try policy(r)
            let (blob, key) = try backend.createSigningKey(policy: p)
            return ["keyBlob": Base64URL.encode(blob), "publicKey": Base64URL.encode(key.publicKeyX963), "policy": p.rawValue]

        case "check.sign":   // one touch
            let digest = try digestBytes(r)
            // The prompt text comes from the object, never from the caller (DESIGN.md section 5).
            if r["reason"] != nil { throw HelperError("bad_request", "reason is not accepted: the helper builds it from the object.") }
            guard let o = r["object"] as? String, let obj = Base64URL.decode(o) else { throw HelperError("bad_request", "object must be base64url.") }
            guard Data(SHA256.hash(data: obj)) == digest else { throw HelperError("digest_mismatch", "digest is not the SHA-256 of object.") }
            // `focus` is a DID that picks one member of a member list; it is never shown by itself (the name and code come from the object).
            var focus: String? = nil
            if let f = r["focus"] { guard let fs = f as? String, fs.count <= 200 else { throw HelperError("bad_request", "focus must be a DID string.") }; focus = fs }
            // `previous` is the signed bytes of the member list before this one: the helper diffs the two and says what is signed.
            var previous: Data? = nil
            if let pv = r["previous"] { guard let ps = pv as? String, let pd = Base64URL.decode(ps), pd.count <= 200_000 else { throw HelperError("bad_request", "previous must be base64url.") }; previous = pd }
            let reason = try validReason(try ReasonText.forObject(obj, focus: focus, previous: previous))
            let blob = try b64(r, "keyBlob")
            let key = try backend.openSigningKey(blob: blob, prompt: Prompt(reason: reason, interactionAllowed: interactionAllowed))
            let sig = try key.sign(digest)           // ECDSA over SHA-256(digest bytes); touch happens here
            return ["signature": Base64URL.encode(sig.derRepresentation), "publicKey": Base64URL.encode(key.publicKeyX963), "reason": reason]

        case "shutdown":
            return [:]

        default:
            throw HelperError("unsupported", "Unknown op \(op).")
        }
    }

    // MARK: field access

    func str(_ r: [String: Any], _ k: String) throws -> String {
        guard let s = r[k] as? String else { throw HelperError("bad_request", "\(k) must be a string.") }
        return s
    }
    func b64(_ r: [String: Any], _ k: String) throws -> Data {
        guard let d = Base64URL.decode(try str(r, k)) else { throw HelperError("bad_request", "\(k) must be base64url.") }
        return d
    }
    func policy(_ r: [String: Any]) throws -> Policy {
        guard let p = Policy(rawValue: try str(r, "policy")) else { throw HelperError("bad_request", "policy is not one of user-presence, biometry-current-set, biometry-any.") }
        return p
    }
    func digestBytes(_ r: [String: Any]) throws -> Data {
        let s = try str(r, "digest")
        guard s.hasPrefix("sha256:"), let d = hexDecode(String(s.dropFirst(7))), d.count == 32 else {
            throw HelperError("bad_request", "digest must be \"sha256:\" and 64 lower-case hex digits.")
        }
        return d
    }

    /// 1 to 120 characters, NFC, no control, format, line or paragraph separator characters.
    /// The same rule as hap-core's device label, so no newline can reshape the system prompt.
    public func validReason(_ s: String) throws -> String {
        let n = s.unicodeScalars.count
        guard n >= 1, n <= Handler.maxReasonScalars else { throw HelperError("bad_request", "reason must be 1 to \(Handler.maxReasonScalars) characters.") }
        guard s.precomposedStringWithCanonicalMapping == s else { throw HelperError("bad_request", "reason must be NFC.") }
        for u in s.unicodeScalars {
            switch u.properties.generalCategory {
            case .control, .format, .lineSeparator, .paragraphSeparator:
                throw HelperError("bad_request", "reason has a control character.")
            default: break
            }
        }
        return s
    }
}
