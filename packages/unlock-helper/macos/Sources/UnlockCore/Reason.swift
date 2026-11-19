import Foundation
import CryptoKit

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
///   - a team member list (`typ` "suveren-team-members"). Version 1 (`prev` null) only, without `previous`: the admin alone; the caller names
///     the member with `focus` (a DID, not a text); name and identity code come from that member's entry. Every later version REQUIRES
///     `previous` (the signed bytes of the list before; DEC-73 step 5): the helper checks sha256(previous) == the list's `prev`
///     (and team, version + 1), diffs the two lists ITSELF and says what the signature does: add one, remove one, replace one by
///     another (the new one's code), sign the same list again, or hand the team over to a member. Any other or mixed difference is refused.
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
    /// The first four groups of the code tell two members of the same name apart; the whole code does not fit next to a 64-character name.
    public static func removeMember(_ name: String, _ code: String) -> String { "remove \(quoted(name)) from the team, code \(firstGroups(code))" }
    public static func replaceMember(_ name: String, _ code: String) -> String { "new identity for \(quoted(name)), code \(code)" }
    static func firstGroups(_ code: String) -> String { code.split(separator: " ").prefix(4).joined(separator: " ") }
    public static let resignList = "sign the team list again"
    public static func handOver(_ name: String) -> String { "hand the team over to \(quoted(name))" }
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

    public static func forObject(_ bytes: Data, focus: String? = nil, previous: Data? = nil) throws -> String {
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
            if let previous = previous { return try memberListChange(bytes, o, previous: previous, focus: focus) }
            // Without `previous` only version 1 (the admin alone, no earlier list) is described; every later version needs the list before it,
            // so a caller cannot get "add" for a list that removes, replaces or hands over.
            guard o["version"] as? Int == 1, o["prev"] is NSNull else { throw HelperError("bad_request", "a member list after version 1 needs `previous`.") }
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

    private struct Member { let did: String; let name: String; let code: String }

    private static func members(_ o: [String: Any]) throws -> [Member] {
        guard let arr = o["members"] as? [[String: Any]], !arr.isEmpty else { throw HelperError("bad_request", "a member list has no members.") }
        var out: [Member] = []
        for m in arr {
            guard let did = m["did"] as? String, let name = m["name"] as? String, !name.isEmpty, let code = m["code"] as? String, isCode(code) else {
                throw HelperError("bad_request", "a member of the list is malformed.")
            }
            out.append(Member(did: did, name: name, code: code))
        }
        guard Set(out.map { $0.did }).count == out.count else { throw HelperError("bad_request", "a member list names a member twice.") }
        return out
    }

    /// What signing `o` does to `previous`, said by the helper from the two objects. The caller supplies no text.
    private static func memberListChange(_ bytes: Data, _ o: [String: Any], previous: Data, focus: String?) throws -> String {
        guard let pany = try? JSONSerialization.jsonObject(with: previous), let p = pany as? [String: Any],
              p["typ"] as? String == "suveren-team-members", Set(p.keys) == memberListMembers else {
            throw HelperError("bad_request", "previous is not a member list.")
        }
        // The list names the one before it by the hash of its signed bytes: the helper compares that, so `previous` cannot be another list.
        let digest = "sha256:" + SHA256.hash(data: previous).map { String(format: "%02x", $0) }.joined()
        guard o["prev"] as? String == digest else { throw HelperError("bad_request", "previous is not the list this one follows.") }
        guard let tid = o["team_id"] as? String, p["team_id"] as? String == tid,
              let v = o["version"] as? Int, let pv = p["version"] as? Int, v == pv + 1,
              let admin = o["admin_did"] as? String, let padmin = p["admin_did"] as? String else {
            throw HelperError("bad_request", "previous is not the version before this list.")
        }
        let now = try members(o), before = try members(p)
        let nowBy = Dictionary(uniqueKeysWithValues: now.map { ($0.did, $0) }), beforeBy = Dictionary(uniqueKeysWithValues: before.map { ($0.did, $0) })
        guard nowBy[admin] != nil, beforeBy[padmin] != nil else { throw HelperError("bad_request", "the admin is not a member.") }
        let added = now.filter { beforeBy[$0.did] == nil }, removed = before.filter { nowBy[$0.did] == nil }
        // a member who stays is the same entry: a changed name or code is a different change this helper does not describe
        for m in now { if let b = beforeBy[m.did], b.name != m.name || b.code != m.code { throw HelperError("bad_request", "a member's entry changed.") } }
        let hasHandover = !(o["handover"] is NSNull) && o["handover"] != nil
        if admin != padmin {
            // hand-over: same members, a new admin, the old admin named in `handover`
            guard added.isEmpty, removed.isEmpty, hasHandover, let h = o["handover"] as? [String: Any], h["admin_did"] as? String == padmin,
                  let to = nowBy[admin] else { throw HelperError("bad_request", "this change of admin is not a plain hand-over.") }
            return handOver(to.name)
        }
        guard !hasHandover else { throw HelperError("bad_request", "a list with the same admin carries no hand-over.") }
        if let f = focus, !added.isEmpty, !added.contains(where: { $0.did == f }) { throw HelperError("bad_request", "focus is not the added member.") }
        switch (added.count, removed.count) {
        case (0, 0): return resignList
        case (1, 0): return addMember(added[0].name, added[0].code)
        case (0, 1):
            guard removed[0].did != padmin else { throw HelperError("bad_request", "the admin cannot be removed.") }
            return removeMember(removed[0].name, removed[0].code)
        case (1, 1):
            guard removed[0].did != padmin else { throw HelperError("bad_request", "the admin cannot be replaced.") }
            return replaceMember(added[0].name, added[0].code)
        default: throw HelperError("bad_request", "this change of the list is not one this helper describes.")
        }
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
