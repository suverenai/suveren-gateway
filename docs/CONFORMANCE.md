# Suveren — HAP implementation report

**Implementation:** Suveren — Suveren Gateway (Gatekeeper + Executor; open source) and Suveren Authority Server (Authority Server; **proprietary**, hosted at suveren.ai), built on `@humanagencyp/hap-core` (open source).
**Specification:** Human Agency Protocol, `content/<version>/` at [humanagencyprotocol/hap-protocol](https://github.com/humanagencyprotocol/hap-protocol).
**Report date:** 2026-10-28 (describes hap-core 0.12.1, Gateway 0.40.0 and the Authority Server on suveren.ai, all speaking the v0.7 wire since 2026-10-09; the previous report was dated 2026-10-09). **Maintainer:** Suveren. **Update rule:** this file changes in the same change as any implementation change that affects a normative requirement.

This is *one implementation's* statement of where it stands against the specification, in the specification's terms (`governance.md` → *Reference Conformance* → *Implementation reports*). It replaces the status registers that lived in the specification's `review.md` until 2026-09-03: a specification must be checkable by readers who cannot see the implementation, and the Authority Server here is proprietary, so status written into the spec was an unverifiable claim.

**Writing your own.** Any implementation may publish a report in this shape, and nothing about it is Suveren-specific: state the protocol version you claim on the wire, which optional surfaces you implement, which conformance vectors you reproduce, and every normative requirement you do not yet meet — named as the specification names it, not as your code names it. Do not describe internals a reader cannot inspect; where a claim rests on code nobody outside can see, say so, as the last section here does.

**What a reader of this report can check.** The Gateway, the core library, the profiles and the test suite ([suveren-e2e](https://github.com/suverenai/suveren-e2e)) are open, so every claim about them is verifiable by running `npm test` with the public repositories checked out. Claims about the Authority Server's internals are the operator's word, and are collected in the final section rather than scattered through the others.

## Version claimed on the wire

- **v0.7.** Mandates are issued with `version: "0.7"` and the v0.7 vocabulary (`mandate_id`, `scope_hash`, `mandate_owners`, `HAP-mandate`), with `issuer` and `profile_hash`; the request carries `supported_versions` and is refused with `VERSION_UNSUPPORTED` when there is no common version. Only v0.7 is supported: mandates issued under earlier versions are refused (`VERSION_UNSUPPORTED`) and re-approved — a deliberate pre-1.0 choice, made possible because no v0.6 mandate was ever issued (earlier mandates were v0.5).
- **Tickets:** carry `version`, `issuer`, `mandateId`, `limits`; signatures are base64url; no `path`. Tickets additionally carry two signed fields the v0.7 specification does not define: `authorizationId` (the grant the Gateway requested the ticket by) and `idempotencyKey` (the request the ticket answers). Both are implementation extensions under v0.7; the v0.8 draft defines the second and allows the first as `mandateId` on the request.
- **Features implemented under v0.7:** content binding (v1 and v2), read authorization, identity assurance (`self_declared`, `as_vouched`), Gatekeeper custody archive, permanent revocation, exactly-once ticket issuance, `appliesTo`, the `intent-disclosure@0.1` companion (with the limitations stated in the specification). `disclose_fields` is validated and signed but never applied: no published profile declares it, so the specified silence is the only behaviour exercised.
- **Built ahead of the specification** (not in v0.7; written into the v0.8 draft from the implementation, see the section *Against the v0.8 draft* below): `review_above_cap` as a signed mode with its caps and approvers; profile-declared `commitment_modes`, `maximum`, and `requiredFor` inside a per-transaction bound; the owner's standing disclosure choice; one execution per ticket; encrypted proposal content; the hash of what the approver was shown; group roles with hard caps.

## Conformance vectors (`content/0.7/vectors/`)

| Set | Status |
|---|---|
| `canonical-bounds-and-scope.json` | Reproduced by the core library and the test suite's helper. |
| `profile-hash.json` | Reproduced by the core library and the test suite. |
| `payload-signatures.json` | Reproduced by the core library (all cases, incl. the owner-signed projection and the co-signed chain). This suite replays the AS-signed cases through the published library; the owner-signed cases are a named gap here. |
| `required-refusals.json` | **Not consumed by the test suite.** The rows are accounted for indirectly: the Authority Server's own tests drive 22 rows through its real routes and assert the code in the `{approved:false, errors:[{code}]}` envelope (*operator's word* — those tests are not public); the core library's tests decide the 9 profile/signature/version rows; the `fail_closed_situations` are Gatekeeper behaviour exercised by the test suite's own scenarios. A suite that read the file would fail on a new row; this one does not. |

Two honesty notes on the vector tests themselves. The suites that read the published files skip silently when the vector directory is absent, so a checkout without the specification repository passes without having checked anything. And several scenario suites pin profile versions that have since been superseded (`customers@0.9`, `email@0.8`, `delegation@0.3`, `purchase@0.7`, `reporting@0.3` and older), so what they prove holds for those versions, not for the ones the Authority Server serves today.

## Requirements met, by area (verifiable through the test suite unless marked *operator's word*)

- Pre-flight ticket before execution, fail-closed on an unreachable Authority Server; no bypass mode, no cached-ticket reuse, no degraded mode.
- Idempotency key per invocation, reused unchanged on retry, no retry past a definitive refusal; the key is signed into the ticket and the Gateway refuses a ticket whose key is not the one it sent.
- Commitment mode routed from the signed payload; commitment-mode downgrade fails closed; `review_above_cap` is a signed mode carrying `above_cap_caps` and `above_cap_approvers`.
- `actionType` taken from the manifest's `staticExecution` only; validated against the profile registry; a write with no action type is refused.
- Closed manifest transform vocabulary; `_`-prefixed keys never enter the execution context.
- Per-transaction bounds and scope constraints (`enum`, `subset`, `requiredFor`) enforced locally before the ticket request.
- Cumulative state recomputed from ticket history with the specified windows (rolling 24 h, rolling 7 d, calendar month UTC) — *operator's word*, exercised by the cumulative-tracking suite. The consumption check and the ticket insert are one transaction on the current store (the four parallel-request races recorded on 2026-09-30 are closed) — *operator's word*.
- Exactly-once issuance: idempotent replay returns the original ticket before any state mutates; review-path `committed → executed` transition is atomic.
- One execution per ticket: the Gateway writes a durable execution record before the downstream call and treats a ticket it has already executed as a recovery signal, not a second authorization.
- Permanent revocation: no un-revoke path; a revoked mandate cannot be renewed under the same id.
- Third-party verification response contains only signed fields, signature, and revocation status.
- Ticket lookup by content: opt-in per profile, rate-limited, indistinguishable not-found.
- `title` never in the signed payload.
- Read authorization: unset window denies (for tools declaring an age dimension); resource scopes bind reads; undeclared read governance denies at runtime and at lint time; query injection is bracketed and fails closed; resource-widening arguments are set by the Gateway, not the agent.
- Content binding: text canonicalization (NFC, LF, trailing whitespace, trailing blank lines), v2 declared fields with `required_fields`, absent/empty equivalence, refusal when no declared field carries a value, identifier normalization before display, transport encoding after hashing.
- Gatekeeper custody: append-only, encrypted, unpruned archive of the complete signed ticket and mandate blobs, with the issuer key on every entry and an offline signature verifier; the archive entry is written before execution and a failed write blocks the action (`wire-switch-v07.test.ts` proves a real gated write's entry verifies offline with only its stored key).
- Scope values do not travel on the **automatic** path: the execution context sent in a ticket request carries only the fields a bound reads and the action type. This is held by Gateway unit tests, not by the test suite. The review path is a requirement not met (below).
- Error codes: every refusal on the wire uses the canonical code in the specification's envelope; implementation-specific codes appear only where the specification assigns none — with one exception listed below.
- Version negotiation and the hard switch: the retired v0.6 ticket path answers 410 `VERSION_UNSUPPORTED`; the Gateway checks the Authority Server's protocol version at start and fails closed on a reported mismatch.
- Notification surfaces carry presence, never content.

## Requirements not met (in the specification's terms)

Against v0.7, the published specification:

- *Privacy Invariant* — on the **review path**, the ticket request carries the full tool arguments to the Authority Server, not only the fields a bound reads. The automatic path is clean. The Authority Server also accepts proposal content in the clear unless the operator sets a flag; encrypted content is implemented but not the only accepted form.
- *Ticket Request Schema* rule 1 — the ticket request is resolved through the authorization record; `boundsHash` is checked against it but is not the sole lookup key.
- *Ticket Issuance* — the request's `profileId` is not checked against the mandate's `profile_id`, and `profile_hash` is not re-checked against the served profile at ticket time; only mandate time checks it.
- *Identity Assurance* — the signed `subjects` field on the ticket is never populated; a disclosed name is recorded beside the ticket, outside the signature.
- *Commitment Modes* (team above-cap) — the number of approvals required is not in the signed mandate, and approvers are named by user identifier rather than DID. The list of who may still approve a pending proposal is supplied by the caller rather than derived from the signed mandate; the Authority Server checks each approval against the signed approver list but not the list itself.
- *Error Codes* — the core library emits `BOUND_EXCEEDED` for a scope `enum` or `subset` violation where the specification names `SCOPE_INVALID_VALUE`; `APPROVAL_REQUIRED` from the team above-cap mechanism names approvers by user identifier.
- *Profiles* — seven of the twelve current profiles (`charge@0.7`, `customers@0.11`, `delegation@0.5`, `invoicing@0.1`, `publish@0.7`, `purchase@0.8`, `sales@0.4`) declare scope enumerations as a field-level `enum`, the form the specification deprecated; `deploy@0.12` declares a field-level `enum` beside its `boundType` (`rollback_allowed`). Four profiles carry fields the v0.7 specification does not define (`enforcedBy`, `enforced`, `field_kinds`, a `source: "static"` on an execution-context field). A new version of each is needed; no in-place edit.
- *Profiles* — the Gatekeeper does not validate a profile when it loads it; only the Authority Server does, and only on the mandate route.
- *Tool-Gating Manifests* — the manifests carry no `manifestVersion`; gating is declared as a default with overrides rather than per tool; the profile reference is a short unversioned name; several write tools declare no `category`, and `category: "disabled"` and per-tool profile overrides are used, none of which the specification defines. One manifest's default action type (`unclassified`) is absent from its profile's registry; one mail tool fixes a recipient count instead of mapping it from the call; calendar update and delete tools set their duration and lookahead values statically.
- *Version negotiation* — the compatibility check at start is best-effort: if the Authority Server's compatibility endpoint is unreachable at boot, the Gateway proceeds as if compatible and fails closed only on a later reported mismatch.
- *Bounds Schema* rule 3 (deviation rule D2 in `review.md`) — the field-name fallback for cumulative bounds still exists in the core library, the Authority Server and three Gateway code paths, although no live mandate can reach it for count bounds since 2026-10-09. The v0.8 draft closes D2, so this must be removed before claiming v0.8.
- *Authority Server Accountability* (`governance.md`; *operator's word*) — mandate storage is not append-only: a renewal overwrites the earlier signed blob under the same record, a revoked mandate with no executions can be hard-deleted together with its blob, and the evidence export omits expired mandates, superseded blobs, decision records and profile bytes.
- *Ticket Verification* — the redacted public ticket page presents a "valid" indicator the specification forbids on a redacted view.
- *Trust on First Use* / *Profile Bytes Retention* — profiles are fetched at runtime; `profile_hash` binds each mandate to the exact bytes, but the bytes are not retained.
- *Mandate Payload* — no signing-key rotation.
- *Validation Steps* — the review path re-issues a ticket without re-running local verification.
- *Owner Signatures* — the `did:key` implementation accepts Ed25519 only, while platform authenticators commonly sign with P-256; the curve for signing DIDs is an open decision that blocks the owner-signature phase.
- *Read Authorization* — per-correspondent overrides not built; post-fetch age enforcement omitted for list/search tools; NFKC normalization absent; the mail container control is a denylist, not the preferred allowlist.
- *Content Binding* — displayed-must-be-bound: a blind-copy recipient is displayed and not bound; mitigated in review mode by full-argument proposal matching only. The v1 `jcs` content hash includes the Gateway's own `_`-prefixed fields (the source link and the attachment seal) when they are present, although neither is sent to the downstream tool, so a verifier recomputing the hash from the record as written gets a different value.
- *Gatekeeper custody* — no owner deletion after the retention floor.
- *Identity DIDs vs signing DIDs* — owner DIDs are decorative `did:key` strings carrying no key; no owner signatures (P2–P5 not started); no WebAuthn.
- *Multi-Owner Coverage Rule* — coverage is checked per record, not as the union of live mandates.
- The enforcement-class annotations — not implemented.

## Against the v0.8 draft

The next specification version is in draft (`content/0.8/`, 2026-10-28, not published). Most of it was written from this implementation, so the status against it is recorded here before the work starts rather than discovered afterwards. The thirteen behavioural requirements of its *Migration from v0.7* section:

| # | v0.8 requirement | Status |
|---|---|---|
| 1 | Only what a bound reads travels; no scope values, no `_` keys | **Met on the automatic path; not met on the review path** (tool arguments sent in the clear). |
| 2 | One execution per ticket, durable record before the call, replay is a recovery signal | Met. |
| 3 | A ticket names its request (`idempotencyKey` signed; Gateway refuses a mismatch) | Met. |
| 4 | Proposal content never at the Authority Server: encrypted, fingerprinted, bound into the ticket; clear content refused | **Partly.** Encryption and the fingerprint exist; clear content is refused only behind an operator flag; the fingerprint is checked at ticket time but **not signed into the ticket**; approver reader keys are served to any authenticated user and bound into nothing. |
| 5 | Group roles: grantors vs above-cap approvers, signed approval count, proposer never counts, hard caps at signing, deciders from the signed mandate | **Partly.** Roles and hard caps exist; the count is unsigned, approvers are user ids, the pending-approver list is caller-supplied. |
| 6 | Group ceilings on reads and capability switches; enum values ordered most-permissive-first | Met for the ceiling; the profiles' enum order is as the draft describes. |
| 7 | Profile-declared `commitment_modes`, `maximum`, `requiredFor` with their refusals | Met where a profile declares them (`delegation@0.5`, `reporting@0.4`, four `requiredFor` profiles). `maximum` and `requiredFor` already refuse with the draft's codes; a disallowed commitment mode refuses with `PROFILE_INVALID` where the draft names `COMMITMENT_MODE_NOT_ALLOWED`. |
| 8 | Standing disclosure choice | Met. |
| 9 | System context beside the bound values; `shown_hash` | Met. |
| 10 | Consumption counts tickets, not outcomes | Met. |
| 11 | Revocation on membership change, cause named | Met: disabling a member revokes their mandates with a recorded reason (*operator's word*). |
| 12 | Approval surfaces: a remote surface is a verifying client | Not met. The only remote approval surface is the Authority Server's own dashboard, which renders from its store and verifies nothing. |
| 13 | Public ticket projection (`HAP-ticket-projection`) and verifier policy | Not met; the current public view is the one *Ticket Verification* already lists as non-conformant. |

Also required to claim v0.8: issue `version: "0.8"`, sign `proposalContentHash` and `above_cap_approvals`, carry the above-cap fields on a `review` mandate in a group with approval-kind caps, address above-cap proposals to exactly the signed approvers, check required-owner coverage as its own role, emit the eight new codes, remove the field-name fallback (D2 closed), emit `SCOPE_INVALID_VALUE` for scope violations, and publish a new version of every profile that moves scope enumerations out of `field.enum` (D3). Added to the draft on 2026-10-29, after the independent re-derivation of its vectors:
- compute `execution_context_hash` as the hash of the RFC 8785 serialization of the profile's `executionContextSchema` — **not met**: the Gateway hashes a different object (profile, domain and group), serialized without JCS;
- refuse a `review_above_cap` mandate whose owner is their own sole approver, in a group or not — **not met**: the Authority Server accepts it outside a team and answers `APPROVAL_REQUIRED`, as v0.7 allowed;
- refuse a reused `idempotencyKey` whose `actionType` differs — *untested*;
- refuse a request without `mandateId` when the owner holds more than one live mandate with the same `bounds_hash` — *untested*;
- run the ticket-time checks in the specified order — *untested*.

Added after the first external review round (2026-10-29):
- the owner signs `binding`, `signing_surface` and `subjects_disclosed` in the mandate projection — **not met**: the projection carries none of them;
- `HAP-approval` carries `proposal_content_hash` beside `content_hash` — **not met**;
- proposal encryption as pinned: HPKE base mode, empty `info` and associated data, IV ‖ ciphertext ‖ tag, the argument object as content — **met**; base64url encoding and `encrypted_keys` keyed by DID — **not met** (standard base64, keyed by account id); signed deciders without a reader key listed as `unreadable` — partly met (they are skipped and reported, not listed);
- refuse a negative or non-numeric value a bound reads, for every action type — *untested*;
- the staged ticket checks, a replay answered first and only to the requesting context, and the proposal state table — *untested*;
- coverage only between mandates with identical approval conditions — *untested*;
- in a group, an unreachable approval count makes the caps hard rather than refusing the mandate — *untested*;
- review needs a v0.8 Gatekeeper; a v0.8 Authority Server accepts no clear proposal content under a v0.7 mandate — *untested*.

Decided before publication (2026-10-30): a v0.8 Authority Server issues no tickets against v0.7 mandates (`VERSION_UNSUPPORTED`) — every owner re-grants — **not met** (the Authority Server serves live v0.7 mandates); decisions on proposals: a reject is final, withdraw, refused decisions (`DECIDER_INVALID`, `PROPOSAL_ALREADY_DECIDED`, `PROPOSAL_WITHDRAWN`) — *untested*; a missing amount needs approval under an approval cap and is refused under a governing sum bound — *untested* (a new `charge` version must exclude its amount-less action types).

Added after the outside-model reviews (2026-10-29): `HAP-approval` signs `action` and `action_type` — **not met**; the Gatekeeper verifies a review ticket's approval signatures before executing — *untested*.

Added after the second external round (2026-10-29), all *untested*: `action_type` no longer travels in `executionContext`; the AS checks `profileId` and the content-binding declaration at ticket time, and on the review path compares `contentHash`/`contentBinding` with the proposal's; the Gatekeeper verifies every ticket's signature and echoed fields; the execution record has a *requested* state and is keyed on the request; above-cap approvers have key-bearing DIDs; numeric manifest mappings refuse non-numbers instead of coercing them.

The draft's vectors were re-derived by independent implementations three times on 2026-10-29, and by both external reviewers (all values agreed); the set changed in the review round, and a re-derivation over the final text runs before publication.

## What the test suite proves

[suveren-e2e](https://github.com/suverenai/suveren-e2e)'s `conformance/core-musts.ts` maps 31 normative MUSTs from *Ticket Issuance*, *Gatekeeper & Executor Behavior*, and *Read Authorization* to the tests there that exercise them against a real Authority Server, real Gateway, and real MCP servers, or to the line above where the requirement is not yet met. A mapping that points nowhere fails the suite. Two caveats: the map's requirement strings are still in the v0.6 vocabulary (*attestation*, *receipt*), and two entries point at the status register that left `review.md` on 2026-09-03 — the pointers resolve to this file's *not met* list by intent, not by text. The vectors are consumed by `test/canonical-vectors.test.ts` and `test/profile-and-signature-vectors.test.ts`; `test/wire-switch-v07.test.ts` covers the v0.7 switch itself (retired path, version refusal, permanent revocation, `PROFILE_INVALID`, offline-verifiable custody).

## What a reader cannot check

The Authority Server's internals: cumulative-state computation, revocation storage, retention, key custody, and the migration behaviour of its stores. Those lines above are the operator's statements. The specification's *Enforcement classes* table says which of them a relying party is trusting the operator for in any case.
