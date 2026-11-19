import Foundation

/// The text of the system prompt for `check.sign`, built HERE from the object that is signed.
/// The caller sends the object (the exact bytes whose SHA-256 is signed) and never any text, so
/// what the person reads cannot be chosen by the caller, only by the object itself, and the object
/// is what the signature covers (DESIGN.md section 5).
///
/// macOS puts "<program> is trying to" in front, so every text starts with a verb in lower case.
/// ALL TEXTS BELOW ARE PLACEHOLDERS for the maintainer's wording (O19). Keep this table and
/// `reasonFor` in test/fake-helper.mjs identical: a test compares them on the same objects.
///
/// Objects known today (anything else is refused with `bad_request`, before any prompt):
///   - a chain entry (`typ` "suveren-chain-entry"), by `op`
///   - a change request for a connector login: exactly request_id, kind, name, change_hash,
///     gateway_key_id, expires_at, with kind "replace" or "remove" and `name` the connector's name
///     (plan section 7; `name` is added so the prompt can say which login)
///   - a Touch ID unlock switch: exactly typ "suveren-platform-unlock", v, action ("enable" | "disable"),
///     nonce, issued_at
///   - the cancel of a request for a new identity: exactly typ "suveren-identity-cancel", v, aud, root_did,
///     key_id, request_id, chain_seq, chain_head, issued_at (hap-core 0.15.0, plan 6.2)
///   - a team anchor (`typ` "suveren-team-anchor", hap-core 0.16.0, DEC-73): "I trust this admin for this team"
///   - a team member list (`typ` "suveren-team-members"): the admin adds a member. The caller names WHICH member with `focus`
///     (a DID, not a text); the name and the identity code come from that member's entry in the object itself.
///   - a mandate grant or change (`typ` "suveren-mandate-grant", `op` "grant" or "change", the fixed members of
///     hap-core's grant and a `profile_id`; plan 4.4). A revoke needs no check, so it has no text.
public enum ReasonText {
    /// A name from the object goes between quotes with `\` and `"` escaped, so no name can end the quote and add words.
    public static func quoted(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }
    public static func genesis(_ label: String) -> String { "set up the device \(quoted(label)) with its own key" }
    public static func add(_ label: String) -> String { "add the device \(quoted(label))" }
    public static func reset(_ label: String) -> String { "replace every device with \(quoted(label))" }
    public static func replaceLogin(_ name: String) -> String { "replace the login of \(quoted(name))" }
    public static func removeLogin(_ name: String) -> String { "remove the login of \(quoted(name))" }
    public static let enableUnlock = "turn on Touch ID unlock for Suveren"
    public static let disableUnlock = "turn off Touch ID unlock for Suveren"
    public static let remove = "remove a device"
    public static let setCheck = "give a device a check key"
    public static let clearCheck = "remove the check key of a device"
    public static let rotateRoot = "replace the recovery code"
    public static let cancelIdentityReset = "cancel the request for a new identity"
    public static let trustAdmin = "trust the admin of the team you asked to join"
    public static let clearAnchor = "stop trusting the admin of a team"
    public static func addMember(_ name: String, _ code: String) -> String { "add \(quoted(name)) to the team, code \(code)" }
    public static func grantMandate(_ profile: String) -> String { "grant the mandate for \(quoted(profile))" }
    public static func changeMandate(_ profile: String) -> String { "change the mandate for \(quoted(profile))" }

    static let changeRequestMembers: Set<String> = ["request_id", "kind", "name", "change_hash", "gateway_key_id", "expires_at"]
    static let unlockSwitchMembers: Set<String> = ["typ", "v", "action", "nonce", "issued_at"]
    static let grantFixedMembers: Set<String> = ["typ", "v", "op", "owner_did", "key_id", "chain_seq", "chain_head", "mandate_id", "mandate_version", "granted_at", "nonce"]
    static let identityCancelMembers: Set<String> = ["typ", "v", "aud", "root_did", "key_id", "request_id", "chain_seq", "chain_head", "issued_at"]

    static let anchorMembers: Set<String> = ["typ", "v", "member_did", "team_id", "admin_did", "version", "prev", "key_id", "chain_seq", "chain_head", "created_at", "nonce"]
    static let memberListMembers: Set<String> = ["typ", "v", "team_id", "version", "prev", "admin_did", "members", "handover", "key_id", "chain_seq", "chain_head", "created_at", "nonce"]
    /// An identity code as the object carries it: digits and single spaces only, so it cannot carry words into the prompt.
    static func isCode(_ s: String) -> Bool {
        s.range(of: #"^[0-9]{4}( [0-9]{4}){5}$"#, options: .regularExpression) != nil
    }

    public static func forObject(_ bytes: Data, focus: String? = nil) throws -> String {
        guard let any = try? JSONSerialization.jsonObject(with: bytes), let o = any as? [String: Any] else {
            throw HelperError("bad_request", "object is not a JSON object.")
        }
        if o["typ"] as? String == "suveren-chain-entry" { return try chainEntry(o) }
        if Set(o.keys) == changeRequestMembers, let name = o["name"] as? String, !name.isEmpty {
            switch o["kind"] as? String {
            case "replace": return replaceLogin(name)
            case "remove": return removeLogin(name)
            default: break
            }
        }
        if o["typ"] as? String == "suveren-platform-unlock", Set(o.keys) == unlockSwitchMembers {
            switch o["action"] as? String {
            case "enable": return enableUnlock
            case "disable": return disableUnlock
            default: break
            }
        }
        if o["typ"] as? String == "suveren-identity-cancel", Set(o.keys) == identityCancelMembers {
            return cancelIdentityReset
        }
        if o["typ"] as? String == "suveren-team-anchor", Set(o.keys) == anchorMembers {
            return o["admin_did"] is NSNull ? clearAnchor : trustAdmin
        }
        if o["typ"] as? String == "suveren-team-members", Set(o.keys) == memberListMembers {
            guard let focus = focus, let members = o["members"] as? [[String: Any]],
                  let m = members.first(where: { $0["did"] as? String == focus }),
                  let name = m["name"] as? String, !name.isEmpty, let code = m["code"] as? String, isCode(code) else {
                throw HelperError("bad_request", "a member list needs a focus that names one of its members.")
            }
            return addMember(name, code)
        }
        if o["typ"] as? String == "suveren-mandate-grant", grantFixedMembers.isSubset(of: Set(o.keys)),
           let profile = o["profile_id"] as? String, !profile.isEmpty {
            switch o["op"] as? String {
            case "grant": return grantMandate(profile)
            case "change": return changeMandate(profile)
            default: break   // a revoke is signed without a check: no text, no prompt
            }
        }
        throw HelperError("bad_request", "object is of a kind this helper has no prompt text for.")
    }

    private static func label(_ o: [String: Any]) throws -> String {
        guard let d = o["device"] as? [String: Any], let l = d["label"] as? String else {
            throw HelperError("bad_request", "chain entry has no device label.")
        }
        return l
    }

    private static func chainEntry(_ o: [String: Any]) throws -> String {
        switch o["op"] as? String {
        case "genesis": return genesis(try label(o))
        case "add": return add(try label(o))
        case "reset": return reset(try label(o))
        case "remove": return remove
        case "set": return o["check"] is NSNull || o["check"] == nil ? clearCheck : setCheck
        case "rotate-root": return rotateRoot
        default: throw HelperError("bad_request", "chain entry has an unknown op.")
        }
    }
}
