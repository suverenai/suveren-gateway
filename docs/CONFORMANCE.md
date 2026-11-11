# Suveren — HAP implementation report

**Implementation:** Suveren — Suveren Gateway (Gatekeeper + Executor; open source) and Suveren Authority Server (Authority Server; **proprietary**, hosted at suveren.ai), built on `@humanagencyp/hap-core` (open source).
**Specification:** Human Agency Protocol, `content/<version>/` at [humanagencyprotocol/hap-protocol](https://github.com/humanagencyprotocol/hap-protocol). **v0.8 was published on 2026-11-02** (`content/0.8/`, commit `ec81c52`).
**Report date:** 2026-11-04 (describes hap-core **0.13.0**, Gateway 0.40.0 and the Authority Server on suveren.ai; the two products still speak the **v0.7** wire; the previous report was dated 2026-10-28). **Maintainer:** Suveren. **Update rule:** this file changes in the same change as any implementation change that affects a normative requirement.
**Update 2026-11-11:** since Gateway 0.41.0, the review path sends the Authority Server only the values a bound reads and the proposal's fingerprint, never the tool arguments. Requirement 1 and the *Privacy Invariant* below are updated for that; everything else still describes Gateway 0.40.0.

This is *one implementation's* statement of where it stands against the specification, in the specification's terms (`governance.md` → *Reference Conformance* → *Implementation reports*). It replaces the status registers that lived in the specification's `review.md` until 2026-09-03: a specification must be checkable by readers who cannot see the implementation, and the Authority Server here is proprietary, so status written into the spec was an unverifiable claim.

**Writing your own.** Any implementation may publish a report in this shape, and nothing about it is Suveren-specific: state the protocol version you claim on the wire, which optional surfaces you implement, which conformance vectors you reproduce, and every normative requirement you do not yet meet — named as the specification names it, not as your code names it. Do not describe internals a reader cannot inspect; where a claim rests on code nobody outside can see, say so, as the last section here does.

**What a reader of this report can check.** The Gateway, the core library, the profiles and the test suite ([suveren-e2e](https://github.com/suverenai/suveren-e2e)) are open, so every claim about them is verifiable by running `npm test` with the public repositories checked out. Claims about the Authority Server's internals are the operator's word, and are collected in the final section rather than scattered through the others.

## Where the implementation stands against v0.8 — in one paragraph

The core library speaks v0.8: `@humanagencyp/hap-core` 0.13.0 issues `version: "0.8"`, verifies `"0.8"` and `"0.7"` artifacts each under its own rules, and reproduces every published v0.8 conformance vector. The Gateway and the Authority Server do not yet: both are still the v0.7 implementation the previous report described. v0.8 is a **re-grant release** (*Migration from v0.7*): when the Authority Server switches, every live mandate is granted again. The switch is planned in three parallel tracks — Gateway, Authority Server, profiles — followed by one switch day; the plan and its decisions are in the Authority Server repository (`docs/v08-wire-plan.md`). Until then the sections below say, requirement by requirement, what is met where.

## Version claimed on the wire

- **Products: v0.7.** Mandates are issued with `version: "0.7"` and the v0.7 vocabulary, with `issuer` and `profile_hash`; the request carries `supported_versions` and is refused with `VERSION_UNSUPPORTED` when there is no common version. A request that supports only `"0.8"` is refused today (426); a request supporting both is served 0.7.
- **Core library: v0.8.** hap-core 0.13.0: `PROTOCOL_VERSION` is `"0.8"`; `SUPPORTED_VERSIONS` is `["0.8", "0.7"]` (what a Gatekeeper sends as `supported_versions`); `negotiateVersion` issues 0.8 only by default (*Version negotiation*, rule 3, exception) and an Authority Server bridging the transition passes the wider set explicitly. A mandate, ticket, projection or approval is verified under the rules and field list of its own `version` (rule 4): a v0.7 ticket is not refused for lacking an `idempotencyKey`, a v0.7 projection carries no `binding`.
- **Tickets today** carry `version`, `issuer`, `mandateId`, `limits`, and the signed `idempotencyKey` v0.8 defines; also `authorizationId`, an implementation extension under both versions (v0.8 allows the same purpose as `mandateId` on the request, which the Authority Server does not yet read).
- **Features implemented under v0.7** (unchanged since the last report): content binding (v1 and v2), read authorization, identity assurance (`self_declared`, `as_vouched`), Gatekeeper custody archive, permanent revocation, exactly-once ticket issuance, `appliesTo`, the `intent-disclosure@0.1` companion; `review_above_cap` as a signed mode; profile-declared `commitment_modes`, `maximum`, `requiredFor`; the standing disclosure choice; one execution per ticket; encrypted proposal content; the hash of what the approver was shown; group roles with hard caps.

## Conformance vectors (`content/0.8/vectors/`)

The five v0.8 sets are normative data (`vectors/README.md`). Every value was computed by one freshly written implementation, re-derived from the specification text by independent implementations in other languages on 2026-10-29 and again over the final text on 2026-10-30 (868 values, all agreeing), and published unchanged with v0.8.

| Set | Status |
|---|---|
| `canonical-bounds-and-scope.json` | Reproduced by the core library and the test suite's helper (unchanged from v0.7; no value changed). |
| `profile-hash.json` | Reproduced by the core library — the four published profiles it names (`charge@0.5`, `delegation@0.6`, `reporting@0.2`, `sales@0.3`), re-indented, re-ordered and with a trailing newline. |
| `payload-signatures.json` | **Reproduced by the core library, all nine cases**: the mandate, the synchronous ticket (`idempotencyKey` signed), the review-path ticket (`proposalId`, `proposalContentHash`, `approvalSignature`), the owner's projection plain and above-cap (`above_cap_approvals`, `binding`, `signing_surface`, `subjects_disclosed`), the approval (`approver_did`, `action`, `action_type`, `proposal_content_hash`), the co-signed mandate, the public ticket projection, and the JCS edge cases. The three chains the README names hold: the co-signed mandate's inner signature is rebuilt from the mandate alone and equals the standalone projection; the review ticket's `approvalSignature` is rebuilt from ticket + mandate and equals the approval case; the projection is built from the review ticket + co-signed mandate and signs to the published bytes. The six v0.7 cases still pass through the same functions. |
| `proposal-encryption.json` | **Reproduced by the core library**: the fingerprint, the reader key pairs from their `ikm`, the envelope byte for byte under the fixed content key, IV and ephemeral keys, and decryption by each reader. |
| `required-refusals.json` | **Consumed by the core library's test suite**: every row is either decided there (42 rows: profile validation, bounds values, group ceilings, above-cap configuration, execution values, version negotiation, owner-signature and approval verification, proposal reader sets) or named AS-only with its reason (46 rows that need a mandate store, ticket history, group configuration or the proposal lifecycle). A new row fails the suite until it is classified. The AS-only rows are what the test suite's v0.8 contract (`test/v08-wire.test.ts`, below) holds the Authority Server to. |

The suites that read the published files fail in CI when the vector directory is absent (a setup error, never a silent pass) and skip loudly locally.

## The thirteen behavioural requirements of v0.8 (*Migration from v0.7*)

| # | v0.8 requirement | Core library (0.13.0) | Gateway (0.40.0) | Authority Server (suveren.ai) |
|---|---|---|---|---|
| 1 | Only what a bound reads travels; no scope values, no `_` keys | `wireExecutionContext`, `checkExecutionValues` | Met since 0.41.0, on both paths: only the values a bound reads, no scope values, no `_` keys. (0.40.0: not met on the review path, tool arguments in the clear.) | **Not met**: `_` keys and keys no bound reads are accepted |
| 2 | One execution per ticket, durable record before the call, replay is a recovery signal | — (Gatekeeper behaviour) | Met | — |
| 3 | A ticket names its request (`idempotencyKey` signed; the Gatekeeper refuses a mismatch) | `verifyTicketAgainstRequest`, `TICKET_REQUEST_MISMATCH` | Met for the key; `mandateId`, `version` and freshness checks not yet wired | Met: the key is signed; `mandateId` on the request is not read |
| 4 | Proposal content never at the AS: encrypted, fingerprinted, bound into the ticket; clear content refused | `encryptProposalContent`, `computeProposalContentHash`, `checkProposalReaders` | Encrypts; envelope not yet in the normative shape (`encrypted_keys` by DID, base64url, `readers`/`unreadable`) | **Partly**: encryption and fingerprint exist; clear content refused only behind an operator flag; fingerprint **not signed into the ticket**; normative envelope and `proposalContentHash` on request and decision not accepted |
| 5 | Group roles: grantors vs approvers, signed approval count, proposer never counts, hard caps at signing, deciders from the signed mandate | `validateAboveCapConfig`, `checkGroupCeilings`, `validateAboveCapFields`, `verifyTicketApprovals` | — | **Partly**: roles and hard caps exist; `above_cap_approvals` unsigned; approvers signed as user ids, **not key-bearing DIDs**; decider list caller-supplied; an owner as their own sole approver accepted |
| 6 | Group ceilings on reads and capability switches; enum values ordered most-permissive-first | `exceedsCap` (enum order) | Met | Met for the ceiling |
| 7 | Profile-declared `commitment_modes`, `maximum`, `requiredFor` with their refusals | `isCommitmentModeAllowed` (`review_above_cap` iff `automatic`), `checkBoundsValues` | — | Met for `maximum` and `requiredFor`; a disallowed mode refuses with the lowercase `commitment_mode_not_allowed`, not `COMMITMENT_MODE_NOT_ALLOWED`; a non-number where a number is declared is `MALFORMED_MANDATE`, not `BOUNDS_INVALID_VALUE`; an enum bound value outside `values` is not refused |
| 8 | Standing disclosure choice | — | — | Met |
| 9 | System context beside the bound values; `shown_hash` | — | Met | Met |
| 10 | Consumption counts tickets, not outcomes | — | — | Met |
| 11 | Revocation on membership change, cause named | — | — | Met (*operator's word*) |
| 12 | Approval surfaces: a remote surface is a verifying client | — | — | **Not met**: the AS dashboard renders from its store and verifies nothing |
| 13 | Public ticket projection and verifier policy | `buildTicketProjection` / `verifyTicketProjection` / `verifyProjectionOwner`; `evaluateVerifierPolicy` with the table's codes | — | **Not met**: no projection is served; the public ticket page is the view *Ticket Verification* lists as non-conformant |

## The contract the Authority Server has to meet (`suveren-e2e`, `test/v08-wire.test.ts`)

Written red on 2026-11-04 from the specification and its refusal vectors, before the Authority Server spoke 0.8, and run against the current Authority Server in the same hour: **7 pass, 25 fail for the stated reasons**. The failing assertions are the open items, in the specification's words:

- *Version negotiation*: a Gatekeeper supporting 0.8 and 0.7 is served 0.7, not 0.8; one supporting 0.8 only is refused; `/api/as/compat` advertises 0.7.
- *Mandate Issuance*, stage 4: `execution_context_hash` is not compared with the hash of the profile's `executionContextSchema`.
- *Bounds Schema*, rules 9–10: a non-number where a number is declared, and an enum value outside `values`, are not refused with `BOUNDS_INVALID_VALUE` (a value above `maximum` is).
- *Mandate Payload*, rule 10; *Group roles*, rules 2 and 4; *Commitment Modes*, rule 7: `above_cap_approvals` is neither required nor signed; an absent or unreachable count, an approver that is not a key-bearing DID, and a cap on a cumulative bound are not refused with `ABOVE_CAP_CONFIG_INVALID`.
- *Ticket Issuance*, stages 1–2: `mandateId` on the request is not read — an unknown one is not `MANDATE_NOT_FOUND`, a disagreeing `boundsHash` is `BOUNDS_HASH_MISMATCH` rather than `MALFORMED_TICKET_REQUEST`; a `_`-prefixed key in `executionContext` is accepted.
- *Ticket Issuance*, stage 7: a negative or non-numeric value a bound reads is not refused with `MALFORMED_TICKET_REQUEST`; an absent amount under a governing `cumulative_sum` bound is issued, not refused with `BOUND_EXCEEDED`.
- *Ticket Payload*: a ticket under a mandate carries `version: "0.7"`.
- *Group roles*, rule 2 and 7: the signed `above_cap_approvers` are user identifiers, not the approvers' key-bearing DIDs; accounts carry a synthetic `did:key` with no key in it, so no approver could be signed as the rule requires.
- *Proposals*, rules 1–9: the normative proposal object (`content.{ciphertext, encrypted_keys, readers, unreadable}`, `proposalContentHash`) is not accepted; clear content, a reader set that differs from the key set, and an approver list or reader set that differs from the signed deciders are not refused with the specified codes; decisions do not carry or compare the fingerprint; `DECIDER_INVALID`, `PROPOSAL_ALREADY_DECIDED`, `PROPOSAL_WITHDRAWN`, `PROPOSAL_CONTENT_MISMATCH` are not emitted; the ticket does not carry `proposalContentHash` or `approvalSignatures`.

Passing already (behaviour the specification wrote down from this implementation): `maximum`, `bounds.profile` vs `profile_id`, an absent value under `requiredFor`, an action type excluded by `appliesTo`, `IDEMPOTENCY_MISMATCH` on a reused key with a different action type, a replay returning the original ticket with its signed key.

The switch itself — a v0.8 Authority Server issuing 0.8 only, refusing a request that does not support 0.8 and refusing tickets against v0.7 mandates — is tested behind an opt-in block of the same file and is off until switch day.

## Requirements met, by area (verifiable through the test suite unless marked *operator's word*)

Unchanged from the previous report, and still true against v0.8 where v0.8 kept the rule:

- Pre-flight ticket before execution, fail-closed on an unreachable Authority Server; no bypass mode, no cached-ticket reuse, no degraded mode.
- Idempotency key per invocation, reused unchanged on retry, no retry past a definitive refusal; the key is signed into the ticket and the Gateway refuses a ticket whose key is not the one it sent.
- Commitment mode routed from the signed payload; commitment-mode downgrade fails closed; `review_above_cap` is a signed mode carrying `above_cap_caps` and `above_cap_approvers`.
- `actionType` taken from the manifest's `staticExecution` only; validated against the profile registry; a write with no action type is refused.
- Closed manifest transform vocabulary; `_`-prefixed keys never enter the execution context on the Gateway side.
- Per-transaction bounds and scope constraints (`enum`, `subset`, `requiredFor`) enforced locally before the ticket request.
- Cumulative state recomputed from ticket history with the specified windows (rolling 24 h, rolling 7 d, calendar month UTC); the consumption check and the ticket insert are one transaction — *operator's word*, exercised by the cumulative-tracking suite.
- Exactly-once issuance: idempotent replay returns the original ticket before any state mutates; review-path `committed → executed` transition is atomic.
- One execution per ticket: durable execution record before the downstream call; a ticket already executed is a recovery signal, not a second authorization.
- Permanent revocation; third-party verification response contains only signed fields, signature, and revocation status; ticket lookup by content opt-in per profile; `title` never in the signed payload.
- Read authorization: unset window denies; resource scopes bind reads; undeclared read governance denies; query injection is bracketed; resource-widening arguments are set by the Gateway.
- Content binding: text canonicalization, v2 declared fields with `required_fields`, absent/empty equivalence, refusal when no declared field carries a value, identifier normalization before display, transport encoding after hashing.
- Gatekeeper custody: append-only, encrypted, unpruned archive of the complete signed ticket and mandate, issuer key on every entry, offline verifier; the archive write precedes execution and a failed write blocks the action.
- Error codes: every refusal on the wire uses the canonical code in the specification's envelope, with the exceptions listed under the contract above and below.
- Version negotiation and the hard switch: the retired v0.6 ticket path answers 410 `VERSION_UNSUPPORTED`; the Gateway checks the Authority Server's protocol version at start and fails closed on a reported mismatch.
- Notification surfaces carry presence, never content.

## Requirements not met, beyond the contract above (in the specification's terms)

- *Privacy Invariant* — the Authority Server accepts proposal content in the clear under a v0.7 mandate unless the operator sets a flag, and stores whatever execution context a gateway sends. (The Gateway carried full tool arguments on the review path until 0.40.0; fixed in 0.41.0.)
- *Ticket Request Schema*, rule 1 — the ticket request is resolved through the authorization record; `boundsHash` is checked against it but is not the sole lookup key, and `mandateId` is not read.
- *Ticket Issuance* — the request's `profileId` is not checked against the mandate's `profile_id`; `profile_hash` is not re-checked against the served profile at ticket time.
- *Identity Assurance* — the signed `subjects` field on the ticket is never populated.
- *Owner Signatures* — accounts carry decorative `did:key` strings with no key; no owner signatures (P2–P5 not started); no WebAuthn; the `did:key` implementation is Ed25519 only.
- *Error Codes* — the core library emits `BOUND_EXCEEDED` for a scope `enum` or `subset` violation where the specification names `SCOPE_INVALID_VALUE`.
- *Profiles* — until the v0.8 profile versions are published, seven of the current profiles declare scope enumerations as field-level `enum` (deviation rule D3 grandfathers them); `deploy@0.12` declares a field-level `enum` beside its `boundType`; `enforced` and a `source: "static"` execution-context field are fields the specification does not define. New versions of every profile that close D3, make every `cumulative_sum` bound's `appliesTo` explicit, remove the duplicate enum and mark `reporting`'s look-back window `enforcedBy: "gatekeeper"` are prepared (hap-profiles, branch `v0.8-profiles`) and validate clean under hap-core 0.13.0; they publish on switch day, because suveren.ai loads profiles live from the repository's main branch. The Gatekeeper still does not validate a profile when it loads it.
- *Tool-Gating Manifests* — no `manifestVersion`; gating declared as a default with overrides; several write tools declare no `category`; one manifest's default action type is absent from its profile's registry; one mail tool fixes a recipient count; calendar tools set duration and lookahead statically.
- *Version negotiation* — the compatibility check at start is best-effort when the compatibility endpoint is unreachable at boot. Also: the Gateway sends `supported_versions: ["0.7"]` and refuses an Authority Server whose advertised versions lack its own; both must change to the `SUPPORTED_VERSIONS` set before the Gateway can run against a 0.8 Authority Server, or against today's 0.7 one after upgrading hap-core.
- *Bounds Schema*, rule 3 (deviation rule D2) — the field-name fallback for cumulative bounds still exists in the core library (`boundActionTypes`, display only), the Authority Server and three Gateway code paths. D2 is closed for v0.8 mandates; the fallback must be removed before claiming v0.8.
- *Authority Server Accountability* (`governance.md`; *operator's word*) — mandate storage is not append-only; the evidence export omits expired mandates, superseded blobs, decision records and profile bytes.
- *Ticket Verification* — the redacted public ticket page presents a "valid" indicator the specification forbids on a redacted view; v0.8's projection is the remedy and is not served yet.
- *Trust on First Use* / *Profile Bytes Retention* — profile bytes are not retained; *Mandate Payload* — no signing-key rotation; *Validation Steps* — the review path re-issues a ticket without re-running local verification.
- *Read Authorization* — per-correspondent overrides not built; post-fetch age enforcement omitted for list/search tools; NFKC normalization absent; the mail container control is a denylist.
- *Content Binding* — displayed-must-be-bound: a blind-copy recipient is displayed and not bound; the v1 `jcs` content hash includes the Gateway's own `_`-prefixed fields when present.
- *Gatekeeper custody* — no owner deletion after the retention floor. *Multi-Owner Coverage Rule* — coverage is checked per record, not as the union of live mandates, and not against identical approval conditions. The enforcement-class annotations — not implemented.

## The three specification-led surfaces of v0.8

Promoted under rule 3 (additive, optional, with a vector) and tracked in `review.md` until an implementation closes them:

| Surface | Status |
|---|---|
| **Public ticket projection** (`HAP-ticket-projection`) | Library code exists: hap-core 0.13.0 builds a projection from a ticket and its mandate, signs it, verifies it (with the validity window applied only as authorization), and verifies the owner entry against the mandate; the `ticket-projection` vector reproduces. **No Authority Server serves one yet**; the ledger entry stays open until one does. |
| **Verifier policy** (`HAP-verifier-policy`) | Library code exists: hap-core 0.13.0 evaluates a policy document line by line with the codes the specification's table assigns (`INVALID_SIGNATURE`, `OWNER_SIGNATURE_REQUIRED`, `PROFILE_HASH_MISMATCH`, `POLICY_UNMET`, `APPROVAL_SIGNATURE_REQUIRED`). The ledger asks for "a verifier — a core-library helper, a pipeline, an auditor's tool"; whether a library helper alone closes it is for the ledger's maintainer to say. No relying party applies one yet. |
| **Remote approval surfaces** | Not implemented. The only remote surface is the Authority Server's dashboard, which verifies nothing before it shows. |

## What the test suite proves

[suveren-e2e](https://github.com/suverenai/suveren-e2e)'s `conformance/core-musts.ts` maps 52 normative MUSTs — from *Ticket Issuance*, *Gatekeeper & Executor Behavior*, *Read Authorization*, and since v0.8 *Mandate Issuance* and *Proposals* — to the tests that exercise them against a real Authority Server, real Gateway and real MCP servers, or to the ledger line that records the gap. A mapping that points nowhere fails the suite. The v0.8 entries point at `test/v08-wire.test.ts` (the red contract above), `test/team-roles-caps.test.ts`, `test/profile-commitment-modes.test.ts`, `test/exactly-once-execution.test.ts` and `test/pe-proposal-encrypted.test.ts`; the Gatekeeper's `TICKET_REQUEST_MISMATCH` check, the wire execution context and the three specification-led surfaces are ledgered. The vectors are consumed by `test/canonical-vectors.test.ts` and `test/profile-and-signature-vectors.test.ts` (now `content/0.8/vectors`, including the review-path ticket); the core library consumes all five sets. Two caveats stand: the map's older requirement strings are still in the v0.6 vocabulary, and several scenario suites pin profile versions that have since been superseded.

## What a reader cannot check

The Authority Server's internals: cumulative-state computation, revocation storage, retention, key custody, and the migration behaviour of its stores. Those lines above are the operator's statements. The specification's *Enforcement classes* table says which of them a relying party is trusting the operator for in any case.
