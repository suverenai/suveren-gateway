import CryptoKit
import Foundation
import Testing
@testable import UnlockCore

// These run the real Handler code path with software P-256 keys (no touch needed) and with
// Secure Enclave keys for everything that needs no touch. What needs a touch is in DESIGN.md
// section 8 as a manual check.

func call(_ h: Handler, _ req: [String: Any]) -> [String: Any] { h.handle(req) }
func code(_ r: [String: Any]) -> String? { (r["error"] as? [String: Any])?["code"] as? String }
let vaultKey = Data((0..<32).map { UInt8($0) })
let software = Handler(backend: SoftwareBackend())
func sha256hex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }

@Suite struct Encoding {
    @Test func base64urlRoundTripAndStrict() {
        for n in 0..<40 {
            let d = Data((0..<n).map { UInt8(($0 * 37 + 11) & 0xff) })
            #expect(Base64URL.decode(Base64URL.encode(d)) == d)
        }
        #expect(Base64URL.decode("ab+/") == nil)
        #expect(Base64URL.decode("abcd=") == nil)
        #expect(Base64URL.decode("a") == nil)
    }
}

@Suite struct Wrapping {
    func make() throws -> (blob: String, pub: String) {
        let r = call(software, ["op": "wrap.create", "policy": "user-presence"])
        #expect(r["ok"] as? Bool == true)
        return (r["keyBlob"] as! String, r["publicKey"] as! String)
    }

    @Test func wrapThenUnwrap() throws {
        let k = try make()
        let w = call(software, ["op": "wrap", "publicKey": k.pub, "vaultKey": Base64URL.encode(vaultKey), "aad": "acct-1"])
        let wrapped = w["wrapped"] as! String
        #expect(Base64URL.decode(wrapped)!.count == 126)
        let u = call(software, ["op": "unwrap", "keyBlob": k.blob, "wrapped": wrapped, "aad": "acct-1"])
        #expect(u["ok"] as? Bool == true)
        #expect(Base64URL.decode(u["vaultKey"] as! String) == vaultKey)
    }

    @Test func twoWrapsOfOneKeyDiffer() throws {
        let k = try make()
        let a = call(software, ["op": "wrap", "publicKey": k.pub, "vaultKey": Base64URL.encode(vaultKey), "aad": "x"])["wrapped"] as! String
        let b = call(software, ["op": "wrap", "publicKey": k.pub, "vaultKey": Base64URL.encode(vaultKey), "aad": "x"])["wrapped"] as! String
        #expect(a != b)
    }

    @Test func wrongAccountOtherKeyAndTamperingAllFail() throws {
        let k = try make(), other = try make()
        let wrapped = call(software, ["op": "wrap", "publicKey": k.pub, "vaultKey": Base64URL.encode(vaultKey), "aad": "acct-1"])["wrapped"] as! String
        #expect(code(call(software, ["op": "unwrap", "keyBlob": k.blob, "wrapped": wrapped, "aad": "acct-2"])) == "unwrap_failed")
        #expect(code(call(software, ["op": "unwrap", "keyBlob": other.blob, "wrapped": wrapped, "aad": "acct-1"])) == "unwrap_failed")
        var bytes = Base64URL.decode(wrapped)!
        bytes[100] ^= 1
        #expect(code(call(software, ["op": "unwrap", "keyBlob": k.blob, "wrapped": Base64URL.encode(bytes), "aad": "acct-1"])) == "unwrap_failed")
        #expect(code(call(software, ["op": "unwrap", "keyBlob": k.blob, "wrapped": "AAAA", "aad": "acct-1"])) == "unwrap_failed")
    }

    @Test func badInputs() throws {
        let k = try make()
        #expect(code(call(software, ["op": "wrap", "publicKey": k.pub, "vaultKey": Base64URL.encode(Data(count: 31)), "aad": "a"])) == "bad_request")
        #expect(code(call(software, ["op": "wrap", "publicKey": "AAAA", "vaultKey": Base64URL.encode(vaultKey), "aad": "a"])) == "bad_request")
        #expect(code(call(software, ["op": "wrap.create", "policy": "anything"])) == "bad_request")
        #expect(code(call(software, ["op": "nope"])) == "unsupported")
        #expect(code(call(software, [:])) == "bad_request")
    }

    @Test func noPromptAllowedMeansInteractionRequired() throws {
        let k = try make()
        let wrapped = call(software, ["op": "wrap", "publicKey": k.pub, "vaultKey": Base64URL.encode(vaultKey), "aad": "a"])["wrapped"] as! String
        let quiet = Handler(backend: SoftwareBackend(), interactionAllowed: false)
        #expect(code(call(quiet, ["op": "unwrap", "keyBlob": k.blob, "wrapped": wrapped, "aad": "a"])) == "interaction_required")
    }

    @Test func idIsEchoed() {
        #expect(call(software, ["op": "hello", "id": 7])["id"] as? Int == 7)
        #expect(call(software, ["op": "hello", "id": "abc"])["id"] as? String == "abc")
    }
}

@Suite struct CheckKey {
    func make() -> (blob: String, pub: String) {
        let r = call(software, ["op": "check.create", "policy": "biometry-current-set"])
        return (r["keyBlob"] as! String, r["publicKey"] as! String)
    }
    let object = Data("{\"typ\":\"suveren-chain-entry\",\"seq\":3}".utf8)

    @Test func signatureIsDerOverTheDigestBytesAndVerifies() throws {
        let k = make()
        let digest = Data(SHA256.hash(data: object))
        let r = call(software, ["op": "check.sign", "keyBlob": k.blob, "digest": "sha256:" + sha256hex(object),
                                "reason": "add the device \"iPhone\"", "object": Base64URL.encode(object)])
        #expect(r["ok"] as? Bool == true)
        let der = Base64URL.decode(r["signature"] as! String)!
        #expect(der[0] == 0x30)
        let pub = try P256.Signing.PublicKey(x963Representation: Base64URL.decode(k.pub)!)
        #expect(pub.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: der), for: digest))
        // a verifier that hashes a different object's digest refuses it
        let other = Data(SHA256.hash(data: Data("other".utf8)))
        #expect(!pub.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: der), for: other))
    }

    @Test func digestMustMatchObjectAndBeWellFormed() {
        let k = make()
        let wrongDigest = "sha256:" + sha256hex(Data("other".utf8))
        #expect(code(call(software, ["op": "check.sign", "keyBlob": k.blob, "digest": wrongDigest, "reason": "x", "object": Base64URL.encode(object)])) == "digest_mismatch")
        for bad in ["", "sha256:abc", "SHA256:" + sha256hex(object), "sha256:" + sha256hex(object).uppercased(), sha256hex(object)] {
            #expect(code(call(software, ["op": "check.sign", "keyBlob": k.blob, "digest": bad, "reason": "x"])) == "bad_request")
        }
    }

    @Test func reasonRules() {
        let k = make()
        let d = "sha256:" + sha256hex(object)
        func sign(_ reason: String) -> [String: Any] { call(software, ["op": "check.sign", "keyBlob": k.blob, "digest": d, "reason": reason]) }
        #expect(sign(String(repeating: "a", count: 120))["ok"] as? Bool == true)
        #expect(code(sign(String(repeating: "a", count: 121))) == "bad_request")
        #expect(code(sign("")) == "bad_request")
        #expect(code(sign("grant\nthe mandate")) == "bad_request")
        #expect(code(sign("grant\u{202E}the mandate")) == "bad_request")   // bidi override
        #expect(code(sign("grant\u{2028}x")) == "bad_request")
        #expect(sign("grant mandate: offers by email, up to 3 per day")["ok"] as? Bool == true)
    }

    @Test func noPromptAllowedMeansInteractionRequired() {
        let k = make()
        let quiet = Handler(backend: SoftwareBackend(), interactionAllowed: false)
        #expect(code(call(quiet, ["op": "check.sign", "keyBlob": k.blob, "digest": "sha256:" + sha256hex(object), "reason": "x"])) == "interaction_required")
    }
}

@Suite struct Caller {
    func procArgs(argc: Int32, exec: String, argv: [String], env: [String]) -> Data {
        var d = Data(); var a = argc
        withUnsafeBytes(of: &a) { d.append(contentsOf: $0) }
        d.append(Data(exec.utf8)); d.append(contentsOf: [0, 0, 0])
        for s in argv + env { d.append(Data(s.utf8)); d.append(0) }
        return d
    }
    let node = AllowedCaller(exe: "/bin/sh", scriptPrefix: "/opt/suveren/app")

    @Test func parsesProcArgs() {
        let p = Caller().procArgs(argc: 2, exec: "/bin/sh", argv: ["node", "/opt/suveren/app/a.js"], env: ["A=1"])
        let a = CallerPolicy.parseProcArgs(p)
        #expect(a == ProcArgs(execPath: "/bin/sh", argv: ["node", "/opt/suveren/app/a.js"], env: ["A=1"]))
        #expect(CallerPolicy.parseProcArgs(Data([1, 2])) == nil)
    }

    @Test func acceptsOnlyTheGatewayScript() {
        let ok = ProcArgs(execPath: "/bin/sh", argv: ["node", "/opt/suveren/app/dist/bin.js"], env: [])
        #expect(CallerPolicy.evaluate(parent: ok, parentExe: "/bin/sh", allowed: [node]) == nil)
        let elsewhere = ProcArgs(execPath: "/bin/sh", argv: ["node", "/tmp/evil.js"], env: [])
        #expect(CallerPolicy.evaluate(parent: elsewhere, parentExe: "/bin/sh", allowed: [node]) != nil)
        let sibling = ProcArgs(execPath: "/bin/sh", argv: ["node", "/opt/suveren/app-evil/x.js"], env: [])
        #expect(CallerPolicy.evaluate(parent: sibling, parentExe: "/bin/sh", allowed: [node]) != nil)
        let withFlag = ProcArgs(execPath: "/bin/sh", argv: ["node", "--require=/tmp/x.js", "/opt/suveren/app/dist/bin.js"], env: [])
        #expect(CallerPolicy.evaluate(parent: withFlag, parentExe: "/bin/sh", allowed: [node]) != nil)
        let opts = ProcArgs(execPath: "/bin/sh", argv: ["node", "/opt/suveren/app/dist/bin.js"], env: ["NODE_OPTIONS=--require /tmp/x.js"])
        #expect(CallerPolicy.evaluate(parent: opts, parentExe: "/bin/sh", allowed: [node]) != nil)
        #expect(CallerPolicy.evaluate(parent: ok, parentExe: "/usr/bin/python3", allowed: [node]) != nil)
        let dotdot = ProcArgs(execPath: "/bin/sh", argv: ["node", "/opt/suveren/app/../../tmp/x.js"], env: [])
        #expect(CallerPolicy.evaluate(parent: dotdot, parentExe: "/bin/sh", allowed: [node]) != nil)
    }

    @Test func readsOwnProcessArgs() {
        let me = CallerPolicy.procArgs(pid: getpid())
        #expect(me != nil)
        #expect(me?.argv.isEmpty == false)
        #expect(CallerPolicy.parentExePath(pid: getpid()) != nil)
    }
}

/// The Secure Enclave, everything that needs no touch. Creating a key writes nothing to the keychain.
@Suite struct SecureEnclaveNoTouch {
    let se = SecureEnclaveBackend()
    var available: Bool { se.capabilities().secureHardware }

    @Test func capabilitiesDoNotPrompt() {
        let c = se.capabilities()
        #expect(c.backend == "secure-enclave")
    }

    @Test func createWrapAndRefuseQuietUse() throws {
        guard available else { return }
        let h = Handler(backend: se, interactionAllowed: false)
        for policy in ["user-presence", "biometry-current-set"] {
            let r = call(h, ["op": "wrap.create", "policy": policy])
            if code(r) == "no_biometry" { continue }        // a Mac without an enrolled finger
            #expect(r["ok"] as? Bool == true, "\(policy): \(r)")
            let pub = r["publicKey"] as! String, blob = r["keyBlob"] as! String
            #expect(Base64URL.decode(pub)!.count == 65)
            let wrapped = call(h, ["op": "wrap", "publicKey": pub, "vaultKey": Base64URL.encode(vaultKey), "aad": "a"])["wrapped"] as! String
            // unwrap needs a touch; with prompts off it must refuse, and never hand out the key
            let u = call(h, ["op": "unwrap", "keyBlob": blob, "wrapped": wrapped, "aad": "a"])
            #expect(code(u) == "interaction_required", "\(policy): \(u)")
            #expect(u["vaultKey"] == nil)

            let c = call(h, ["op": "check.create", "policy": policy])
            let s = call(h, ["op": "check.sign", "keyBlob": c["keyBlob"] as! String, "digest": "sha256:" + sha256hex(Data("x".utf8)), "reason": "test"])
            #expect(code(s) == "interaction_required", "\(policy): \(s)")
            #expect(s["signature"] == nil)
        }
    }

    @Test func aBlobFromNowhereIsInvalid() {
        guard available else { return }
        let h = Handler(backend: se, interactionAllowed: false)
        let r = call(h, ["op": "check.sign", "keyBlob": Base64URL.encode(Data(repeating: 7, count: 300)), "digest": "sha256:" + sha256hex(Data()), "reason": "x"])
        #expect(code(r) == "key_invalid")
    }
}
