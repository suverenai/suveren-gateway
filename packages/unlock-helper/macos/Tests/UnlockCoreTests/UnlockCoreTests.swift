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
/// The gateway wraps in Node; the helper has no `wrap` op. Tests wrap with the library function (same bytes).
func wrapFor(_ pub: String, _ aad: String, key: Data = vaultKey) -> String {
    Base64URL.encode(try! Wrap.wrap(vaultKey: key, wrapPublicKeyX963: Base64URL.decode(pub)!, aad: aad))
}
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
        let wrapped = wrapFor(k.pub, "acct-1")
        #expect(Base64URL.decode(wrapped)!.count == 126)
        let u = call(software, ["op": "unwrap", "keyBlob": k.blob, "wrapped": wrapped, "aad": "acct-1"])
        #expect(u["ok"] as? Bool == true)
        #expect(Base64URL.decode(u["vaultKey"] as! String) == vaultKey)
    }

    @Test func twoWrapsOfOneKeyDiffer() throws {
        let k = try make()
        let a = wrapFor(k.pub, "x")
        let b = wrapFor(k.pub, "x")
        #expect(a != b)
    }

    @Test func wrongAccountOtherKeyAndTamperingAllFail() throws {
        let k = try make(), other = try make()
        let wrapped = wrapFor(k.pub, "acct-1")
        #expect(code(call(software, ["op": "unwrap", "keyBlob": k.blob, "wrapped": wrapped, "aad": "acct-2"])) == "unwrap_failed")
        #expect(code(call(software, ["op": "unwrap", "keyBlob": other.blob, "wrapped": wrapped, "aad": "acct-1"])) == "unwrap_failed")
        var bytes = Base64URL.decode(wrapped)!
        bytes[100] ^= 1
        #expect(code(call(software, ["op": "unwrap", "keyBlob": k.blob, "wrapped": Base64URL.encode(bytes), "aad": "acct-1"])) == "unwrap_failed")
        #expect(code(call(software, ["op": "unwrap", "keyBlob": k.blob, "wrapped": "AAAA", "aad": "acct-1"])) == "unwrap_failed")
    }

    @Test func badInputs() throws {
        let k = try make()
        // the helper never wraps: the plaintext vault key is not something it is sent
        #expect(code(call(software, ["op": "wrap", "publicKey": k.pub, "vaultKey": Base64URL.encode(vaultKey), "aad": "a"])) == "unsupported")
        #expect(code(call(software, ["op": "wrap.create", "policy": "anything"])) == "bad_request")
        #expect(code(call(software, ["op": "nope"])) == "unsupported")
        #expect(code(call(software, [:])) == "bad_request")
    }

    @Test func noPromptAllowedMeansInteractionRequired() throws {
        let k = try make()
        let wrapped = wrapFor(k.pub, "a")
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
    func entry(_ op: String, label: String? = "iPhone", check: String = "null") -> Data {
        let device = label.map { "{\"label\":\"\($0)\"}" } ?? "null"
        return Data("{\"typ\":\"suveren-chain-entry\",\"op\":\"\(op)\",\"seq\":3,\"device\":\(device),\"check\":\(check)}".utf8)
    }
    let object = Data("{\"typ\":\"suveren-chain-entry\",\"op\":\"add\",\"seq\":3,\"device\":{\"label\":\"iPhone\"}}".utf8)
    func sign(_ k: (blob: String, pub: String), _ obj: Data, extra: [String: Any] = [:]) -> [String: Any] {
        var req: [String: Any] = ["op": "check.sign", "keyBlob": k.blob, "digest": "sha256:" + sha256hex(obj), "object": Base64URL.encode(obj)]
        for (a, b) in extra { req[a] = b }
        return call(software, req)
    }

    @Test func signatureIsDerOverTheDigestBytesAndVerifies() throws {
        let k = make()
        let digest = Data(SHA256.hash(data: object))
        let r = sign(k, object)
        #expect(r["ok"] as? Bool == true)
        #expect(r["reason"] as? String == "add the device \"iPhone\"")   // what the prompt showed
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
        #expect(code(call(software, ["op": "check.sign", "keyBlob": k.blob, "digest": wrongDigest, "object": Base64URL.encode(object)])) == "digest_mismatch")
        for bad in ["", "sha256:abc", "SHA256:" + sha256hex(object), "sha256:" + sha256hex(object).uppercased(), sha256hex(object)] {
            #expect(code(call(software, ["op": "check.sign", "keyBlob": k.blob, "digest": bad, "object": Base64URL.encode(object)])) == "bad_request")
        }
        // no object: nothing to build the prompt text from
        #expect(code(call(software, ["op": "check.sign", "keyBlob": k.blob, "digest": "sha256:" + sha256hex(object)])) == "bad_request")
    }

    @Test func theCallerCannotSupplyPromptText() {
        let k = make()
        #expect(code(sign(k, object, extra: ["reason": "grant the mandate: anything at all"])) == "bad_request")
        #expect(code(sign(k, object, extra: ["reason": ""])) == "bad_request")
    }

    @Test func textComesFromTheObject() {
        let k = make()
        func reason(_ obj: Data) -> String? { sign(k, obj)["reason"] as? String }
        #expect(reason(entry("genesis", label: "This computer")) == "set up the device \"This computer\" with its own key")
        #expect(reason(entry("add", label: "Work Mac")) == "add the device \"Work Mac\"")
        #expect(reason(entry("reset", label: "New Mac")) == "replace every device with \"New Mac\"")
        #expect(reason(entry("remove", label: nil)) == "remove a device")
        #expect(reason(entry("set", label: nil, check: "{\"type\":\"platform\",\"pub\":\"x\"}")) == "give a device a check key")
        #expect(reason(entry("set", label: nil)) == "remove the check key of a device")
        #expect(reason(entry("rotate-root", label: nil)) == "replace the recovery code")
        func change(_ kind: String) -> Data {
            Data("{\"request_id\":\"a\",\"kind\":\"\(kind)\",\"name\":\"gmail\",\"change_hash\":\"b\",\"gateway_key_id\":null,\"expires_at\":1}".utf8)
        }
        #expect(reason(change("replace")) == "replace the login of \"gmail\"")
        #expect(reason(change("remove")) == "remove the login of \"gmail\"")
        func unlock(_ action: String) -> Data {
            Data("{\"typ\":\"suveren-platform-unlock\",\"v\":1,\"action\":\"\(action)\",\"nonce\":\"n\",\"issued_at\":1}".utf8)
        }
        #expect(reason(unlock("enable")) == "turn on Touch ID unlock for Suveren")
        #expect(reason(unlock("disable")) == "turn off Touch ID unlock for Suveren")
        let cancel = "{\"typ\":\"suveren-identity-cancel\",\"v\":1,\"aud\":\"a\",\"root_did\":\"d\",\"key_id\":\"k\",\"request_id\":\"r\",\"chain_seq\":1,\"chain_head\":\"h\",\"issued_at\":1}"
        #expect(reason(Data(cancel.utf8)) == "cancel the request for a new identity")
        let passkey = "{\"typ\":\"suveren-passkey-register\",\"v\":1,\"root_did\":\"d\",\"key_id\":\"k\",\"chain_seq\":1,\"chain_head\":\"h\",\"request_id\":\"r\",\"cred_id\":\"c\",\"rp_id\":\"suveren.ai\",\"issued_at\":1}"
        #expect(reason(Data(passkey.utf8)) == "add a passkey for your Suveren dashboard")
        func grant(_ op: String, _ profile: String = "email@0.9") -> Data {
            Data("{\"typ\":\"suveren-mandate-grant\",\"v\":1,\"op\":\"\(op)\",\"owner_did\":\"d\",\"key_id\":\"k\",\"chain_seq\":1,\"chain_head\":\"h\",\"mandate_id\":\"m\",\"mandate_version\":1,\"granted_at\":1,\"nonce\":\"n\",\"profile_id\":\"\(profile)\",\"bounds_hash\":\"x\"}".utf8)
        }
        #expect(reason(grant("grant")) == "grant the mandate for \"email@0.9\"")
        #expect(reason(grant("change")) == "change the mandate for \"email@0.9\"")
        // a revoke is signed without a check: it has no text, so no prompt can be raised for it
        #expect(code(sign(k, grant("revoke"))) == "bad_request")
    }

    @Test func objectsWithNoTextAreRefusedBeforeAnyPrompt() {
        let k = make()
        for bad in ["not json", "[]", "{}", "{\"typ\":\"other\"}",
                    "{\"typ\":\"suveren-chain-entry\",\"op\":\"launch\"}",
                    "{\"typ\":\"suveren-chain-entry\",\"op\":\"add\",\"device\":null}",
                    // a change request with a member too many or too few, or another kind
                    "{\"request_id\":\"a\",\"kind\":\"delete\",\"name\":\"g\",\"change_hash\":\"b\",\"gateway_key_id\":null,\"expires_at\":1}",
                    "{\"request_id\":\"a\",\"kind\":\"remove\",\"name\":\"g\",\"change_hash\":\"b\",\"expires_at\":1}",
                    // the old five-member request has no connector name: no text, no prompt
                    "{\"request_id\":\"a\",\"kind\":\"remove\",\"change_hash\":\"b\",\"gateway_key_id\":null,\"expires_at\":1}",
                    "{\"request_id\":\"a\",\"kind\":\"remove\",\"name\":\"\",\"change_hash\":\"b\",\"gateway_key_id\":null,\"expires_at\":1}",
                    "{\"typ\":\"suveren-platform-unlock\",\"v\":1,\"action\":\"toggle\",\"nonce\":\"n\",\"issued_at\":1}",
                    "{\"typ\":\"suveren-platform-unlock\",\"v\":1,\"action\":\"enable\",\"nonce\":\"n\",\"issued_at\":1,\"note\":\"x\"}",
                    // a cancel with a member too many or too few has no text
                    "{\"typ\":\"suveren-identity-cancel\",\"v\":1,\"aud\":\"a\",\"root_did\":\"d\",\"key_id\":\"k\",\"request_id\":\"r\",\"chain_seq\":1,\"chain_head\":\"h\",\"issued_at\":1,\"note\":\"x\"}",
                    "{\"typ\":\"suveren-identity-cancel\",\"v\":1,\"aud\":\"a\",\"root_did\":\"d\",\"key_id\":\"k\",\"request_id\":\"r\",\"chain_seq\":1,\"chain_head\":\"h\"}",
                    // a passkey approval with a member too many (free text) or too few has no text
                    "{\"typ\":\"suveren-passkey-register\",\"v\":1,\"root_did\":\"d\",\"key_id\":\"k\",\"chain_seq\":1,\"chain_head\":\"h\",\"request_id\":\"r\",\"cred_id\":\"c\",\"rp_id\":\"s\",\"issued_at\":1,\"note\":\"x\"}",
                    "{\"typ\":\"suveren-passkey-register\",\"v\":1,\"root_did\":\"d\",\"key_id\":\"k\",\"chain_seq\":1,\"chain_head\":\"h\",\"request_id\":\"r\",\"cred_id\":\"c\",\"issued_at\":1}",
                    "{\"request_id\":\"a\",\"kind\":\"remove\",\"name\":\"g\",\"change_hash\":\"b\",\"gateway_key_id\":null,\"expires_at\":1,\"note\":\"x\"}"] {
            #expect(code(sign(k, Data(bad.utf8))) == "bad_request", "\(bad)")
        }
    }

    @Test func aNameIsQuotedAndEscapedSoItCannotAddWords() {
        let k = make()
        func reason(_ json: String) -> String? { sign(k, Data(json.utf8))["reason"] as? String }
        // a label with a quote in it: the quote is escaped, so `x" and then approve "y` stays inside the quotes
        #expect(reason("{\"typ\":\"suveren-chain-entry\",\"op\":\"add\",\"device\":{\"label\":\"x\\\" and approve \\\"y\"}}") == "add the device \"x\\\" and approve \\\"y\"")
        #expect(reason("{\"typ\":\"suveren-chain-entry\",\"op\":\"add\",\"device\":{\"label\":\"a\\\\\"}}") == "add the device \"a\\\\\"")
    }

    @Test func aLabelCannotReshapeThePrompt() {
        let k = make()
        #expect(code(sign(k, Data("{\"typ\":\"suveren-chain-entry\",\"op\":\"add\",\"device\":{\"label\":\"a\\nb\"}}".utf8))) == "bad_request")   // a real newline
        #expect(code(sign(k, Data("{\"typ\":\"suveren-chain-entry\",\"op\":\"add\",\"device\":{\"label\":\"a\\u202eb\"}}".utf8))) == "bad_request")  // bidi override
        let long = String(repeating: "a", count: 110)
        #expect(code(sign(k, entry("add", label: long))) == "bad_request")                  // text over 120 characters
    }

    @Test func noPromptAllowedMeansInteractionRequired() {
        let k = make()
        let quiet = Handler(backend: SoftwareBackend(), interactionAllowed: false)
        #expect(code(call(quiet, ["op": "check.sign", "keyBlob": k.blob, "digest": "sha256:" + sha256hex(object), "object": Base64URL.encode(object)])) == "interaction_required")
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
            let wrapped = wrapFor(pub, "a")
            // unwrap needs a touch; with prompts off it must refuse, and never hand out the key
            let u = call(h, ["op": "unwrap", "keyBlob": blob, "wrapped": wrapped, "aad": "a"])
            #expect(code(u) == "interaction_required", "\(policy): \(u)")
            #expect(u["vaultKey"] == nil)

            let c = call(h, ["op": "check.create", "policy": policy])
            let obj = Data("{\"typ\":\"suveren-chain-entry\",\"op\":\"remove\"}".utf8)
            let s = call(h, ["op": "check.sign", "keyBlob": c["keyBlob"] as! String, "digest": "sha256:" + sha256hex(obj), "object": Base64URL.encode(obj)])
            #expect(code(s) == "interaction_required", "\(policy): \(s)")
            #expect(s["signature"] == nil)
        }
    }

    @Test func aBlobFromNowhereIsInvalid() {
        guard available else { return }
        let h = Handler(backend: se, interactionAllowed: false)
        let r = call(h, ["op": "check.sign", "keyBlob": Base64URL.encode(Data(repeating: 7, count: 300)), "digest": "sha256:" + sha256hex(Data("{\"typ\":\"suveren-chain-entry\",\"op\":\"remove\"}".utf8)), "object": Base64URL.encode(Data("{\"typ\":\"suveren-chain-entry\",\"op\":\"remove\"}".utf8))])
        #expect(code(r) == "key_invalid")
    }
}

@Suite struct MemberListChanges {
    // DEC-73 step 5: the helper diffs a member list against `previous` and builds the text itself.
    func member(_ did: String, _ name: String, _ code: String) -> [String: Any] { ["did": did, "name": name, "code": code] }
    func list(_ version: Int, _ prev: String, _ admin: String, _ members: [[String: Any]], handover: Any = NSNull()) -> Data {
        let o: [String: Any] = ["typ": "suveren-team-members", "v": 1, "team_id": "t1", "version": version, "prev": prev, "admin_did": admin, "members": members,
                                "handover": handover, "key_id": "k", "chain_seq": 0, "chain_head": "h", "created_at": 1, "nonce": "n"]
        return try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
    }
    let a = "did:key:z6MkAdmin1111111111111111111111111111111111", m = "did:key:z6MkMember111111111111111111111111111111111", n = "did:key:z6MkNewone111111111111111111111111111111111"
    var anna: [String: Any] { member(a, "Anna Muster", "7314 2208 5561 0942 3375 0001") }
    var maria: [String: Any] { member(m, "Maria Huber", "4721 8830 1169 2284 0937 1250") }
    var newo: [String: Any] { member(n, "Maria Huber", "1111 2222 3333 4444 5555 6666") }
    var before: Data { list(2, "sha256:" + String(repeating: "0", count: 64), a, [anna, maria]) }
    var hash: String { "sha256:" + sha256hex(before) }

    @Test func sayswhatIsSigned() throws {
        #expect(try ReasonText.forObject(list(3, hash, a, [anna]), previous: before) == "remove \"Maria Huber\" from the team, code 4721 8830 1169 2284")
        #expect(try ReasonText.forObject(list(3, hash, a, [anna, newo]), previous: before) == "new identity for \"Maria Huber\", code 1111 2222 3333 4444 5555 6666")
        #expect(try ReasonText.forObject(list(3, hash, a, [anna, maria]), previous: before) == "sign the team list again")
        let h: [String: Any] = ["admin_did": a, "key_id": "ka", "chain_seq": 1, "chain_head": "x"]
        #expect(try ReasonText.forObject(list(3, hash, m, [anna, maria], handover: h), previous: before) == "hand the team over to \"Maria Huber\"")
        #expect(try ReasonText.forObject(list(3, hash, a, [anna, maria, newo]), previous: before) == "add \"Maria Huber\" to the team, code 1111 2222 3333 4444 5555 6666")
    }

    @Test func refusesWhatItCannotDescribe() {
        func refused(_ o: Data, _ p: Data) -> Bool { (try? ReasonText.forObject(o, previous: p)) == nil }
        #expect(refused(list(3, "sha256:" + String(repeating: "1", count: 64), a, [anna]), before))   // not the list it follows
        #expect(refused(list(4, hash, a, [anna]), before))                                          // not the next version
        #expect(refused(list(3, hash, a, [maria]), before))                                         // the admin removed
        #expect(refused(list(3, hash, m, [anna, maria]), before))                                   // change of admin without a hand-over
        #expect(refused(list(3, hash, a, [anna, member(m, "Mallory", "4721 8830 1169 2284 0937 1250")]), before))   // a changed entry
        #expect((try? ReasonText.forObject(list(2, hash, a, [anna, maria]), focus: m)) == nil)                // version 2 without previous
        #expect(refused(list(3, hash, a, [anna]), Data("{}".utf8)))                                  // previous is not a list
    }

    @Test func handlerAcceptsPreviousOnlyAsBase64url() {
        let obj = list(3, hash, a, [anna])
        let k = call(software, ["op": "check.create", "policy": "user-presence"])
        let r = call(software, ["op": "check.sign", "keyBlob": k["keyBlob"] as! String, "digest": "sha256:" + sha256hex(obj), "object": Base64URL.encode(obj), "previous": "***"])
        #expect(code(r) == "bad_request")
    }
}
