import CryptoKit
import Foundation

/// A second wrap of the 32-byte vault key. ECIES-style, so that wrapping needs no touch
/// (public key only) and unwrapping needs the person (the private key stays in the hardware).
///
///   wrapped = base64url( 0x01 || ephemeralPublicKey(65, X9.63) || AES-GCM(nonce12 || ciphertext32 || tag16) )
///   key     = HKDF-SHA256( ECDH(ephemeral, wrapPublicKey), salt = ephemeralPub || wrapPub,
///                          info = "suveren-unlock-wrap-v1", 32 bytes )
///   aad     = UTF-8 of the caller's string (the gateway passes the account id, like vault.ts does)
public enum Wrap {
    static let version: UInt8 = 0x01
    static let info = Data("suveren-unlock-wrap-v1".utf8)

    static func derive(_ secret: SharedSecret, ephemeral: Data, wrapPub: Data) -> SymmetricKey {
        secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: ephemeral + wrapPub, sharedInfo: info, outputByteCount: 32)
    }

    public static func wrap(vaultKey: Data, wrapPublicKeyX963: Data, aad: String) throws -> Data {
        guard vaultKey.count == 32 else { throw HelperError("bad_request", "vaultKey must be 32 bytes.") }
        guard let pub = try? P256.KeyAgreement.PublicKey(x963Representation: wrapPublicKeyX963) else {
            throw HelperError("bad_request", "publicKey is not a P-256 point.")
        }
        let eph = P256.KeyAgreement.PrivateKey()
        let ephPub = eph.publicKey.x963Representation
        let secret = try eph.sharedSecretFromKeyAgreement(with: pub)
        let key = derive(secret, ephemeral: ephPub, wrapPub: wrapPublicKeyX963)
        let sealed = try AES.GCM.seal(vaultKey, using: key, authenticating: Data(aad.utf8))
        return Data([version]) + ephPub + sealed.combined!
    }

    /// The key agreement is where the touch happens: `key` must be opened with a prompt.
    public static func unwrap(wrapped: Data, key: AgreementKey, aad: String) throws -> Data {
        guard wrapped.count == 1 + 65 + 60, wrapped[wrapped.startIndex] == version else {
            throw HelperError("unwrap_failed", "Not a wrap this helper made.")
        }
        let ephPub = wrapped.subdata(in: (wrapped.startIndex + 1)..<(wrapped.startIndex + 66))
        let body = wrapped.subdata(in: (wrapped.startIndex + 66)..<wrapped.endIndex)
        guard let peer = try? P256.KeyAgreement.PublicKey(x963Representation: ephPub) else {
            throw HelperError("unwrap_failed", "Not a wrap this helper made.")
        }
        let secret = try key.sharedSecret(with: peer)          // touch happens here
        let sym = derive(secret, ephemeral: ephPub, wrapPub: key.publicKeyX963)
        guard let box = try? AES.GCM.SealedBox(combined: body),
              let plain = try? AES.GCM.open(box, using: sym, authenticating: Data(aad.utf8)),
              plain.count == 32
        else { throw HelperError("unwrap_failed", "The wrap does not open here (other key, other account, or damaged).") }
        return plain
    }
}
