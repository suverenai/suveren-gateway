/**
 * SP API Client for Platform UI
 *
 * All requests go through the control-plane, which proxies /api/* to the SP.
 * Authentication is API-key-based (X-API-Key header on every request).
 * No cookies are used — the API key is stored in React state only.
 */

import { queueDomains, mergeProposals } from './my-queue';

export interface SPUser {
  id: string;
  name: string;
  email: string;
  did: string;
}

export interface SPGroup {
  id: string;
  name: string;
  myDomains: string[];
  isAdmin: boolean;
  /** v0.4: true for the auto-provisioned single-member personal workspace. */
  isPersonal?: boolean;
}

export interface GroupMember {
  groupId: string;
  userId: string;
  domains: string[];
  joinedAt: number;
  role: string;
  status?: 'active' | 'disabled';
  disabledAt?: number;
  disabledBy?: string;
}

/**
 * Work-plan "Added 2026-10-11 — an account is Personal OR in one team":
 * what joining/creating a team would end for the caller — their OWN live
 * (unrevoked) Personal mandates, and how many still-pending proposals ride
 * on them. Shown by the join/create previews BEFORE the person confirms;
 * `ended` on the real join-confirm/create calls reports the same counts
 * AFTER the fact.
 */
export interface PersonalMandateSummary {
  id: string;
  profileId: string;
  title: string | null;
  commitmentMode: 'automatic' | 'review' | 'review_above_cap' | null;
}

export interface PersonalEndingPreview {
  personalMandates: PersonalMandateSummary[];
  pendingPersonalProposals: number;
}

export interface JoinPreview extends PersonalEndingPreview {
  groupId: string;
  groupName: string;
  admin: { name: string };
}

/** The caller's own pending request to join a team — created by
 *  `requestToJoinGroup`, ended by `withdrawJoinRequest` or by the team
 *  admin confirming/declining it (not from this gateway's UI — that
 *  happens on the Authority Server dashboard). */
export interface PendingJoinRequest {
  groupId: string;
  groupName: string;
  requestedAt: number;
}

export interface AttestResponse {
  /** Per-ceremony identity — REQUIRED; its absence means a pre-identity AS. */
  authorization_id?: string;
  /** v0.7 (was `attestation_id`). */
  mandate_id: string;
  bounds_hash?: string;
  /** v0.7 (was `context_hash`). */
  scope_hash?: string;
  domain: string;
  blob: string;
  expires_at: number;
  status: 'active' | 'pending';
  attested_domains: string[];
  required_domains: string[];
}

export interface ProfileSummary {
  id: string;
  name?: string;
  version: string;
  description: string;
  paths: string[];
  /** One line on what this version changed — shown to owners still on an older one. */
  whatsNew?: string;
  /** Optional declared icon key (see lib/profile-identity.ts). No shipped profile sets this yet. */
  icon?: string;
}

export interface PendingItem {
  authorization_id: string;
  profile_id: string;
  path: string;
  title: string | null;
  sp_status: string | null;
  frame: Record<string, string | number>;
  required_domains: string[];
  attested_domains: string[];
  missing_domains: string[];
  deferred_commitment_domains: string[];
  created_at: string;
  earliest_expiry: string | null;
  remaining_seconds: number | null;
  /** Phase 6: frozen approver list at authority creation time. */
  approvers_frozen: string[];
  /** Phase 6: true when authority was created above a team cap. */
  above_cap: boolean;
}

export interface AttestationsResult {
  authorization_id: string;
  attestations: Array<{ domain: string; blob: string; expires_at: number }>;
  complete: boolean;
  frame?: Record<string, string | number>;
  profile_id?: string;
  path?: string;
  required_domains?: string[];
  attested_domains?: string[];
}

export interface VaultStatus {
  initialized: boolean;
  credentialNames: string[];
  serviceCount: number;
}

/** A single read block from the Gatekeeper (no message content). */
export type DenialReason =
  | 'ungoverned' | 'read_gate' | 'unset_age' | 'age' | 'resource' | 'spam' | 'query_unsafe';
/** Every refusal the gateway records — reads (original F7.4 shape, via
 * `reason`/`target`) and, since AU2 (work-plan.md "Added 2026-10-09"), every
 * other refusal of a gated call. Absent `kind` ⇒ 'read' (every record
 * predating AU2). Never carries message content — identifiers, field names
 * and numbers only. */
export type DenialKind = 'read' | 'bound' | 'scope' | 'cumulative' | 'simulation' | 'not_authorized';
export interface DenialRecord {
  ts: number;
  tool: string;
  integrationId: string;
  profile: string | null;
  kind?: DenialKind;
  reason?: DenialReason;
  detail: string;
  target?: string;
  mandateId?: string;
  mandateTitle?: string;
  field?: string;
  value?: number | string;
  limit?: number | string;
  who?: 'gateway' | 'authority-server';
  code?: string;
}

// ─── AU3/AU5: approval preview + after-execution outcome ───────────────────
// Interface contract: temp/briefs/au3-au5-brief.md. Built against by two
// agents in parallel (UI here, control-plane + mcp-server elsewhere) — do
// not change these shapes without the brief's owner.

/** The read tool's structured/text answer, generic across any MCP server. */
export interface PreviewBody {
  structured?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  text?: string;
}

export interface PreviewVersionInfo {
  /** The action argument carrying the document version, e.g. "revision". */
  field: string;
  approved: string | number;
  current: string | number;
  stale: boolean;
  /** Only present when `stale` — the re-read without the version arg. */
  currentBody?: PreviewBody;
}

// ─── AU8: several reads per preview ────────────────────────────────────────
// Interface contract: temp/briefs/au8-brief.md. Mirrors
// apps/control-plane/src/lib/preview-types.ts and apps/mcp-server/src/lib/
// preview.ts's `PreviewReadSection`/`ToolDisplayHints` — do not change these
// shapes without the brief's owner.

/** A read's outcome where "nothing to read" (no_target) is itself a valid,
 *  non-error outcome. */
export type PreviewReadOutcome =
  | { status: 'ok'; body: PreviewBody }
  | { status: 'unavailable'; reason: 'no_connector' | 'connector_error' | 'timeout'; message?: string }
  | { status: 'not_found'; message?: string }
  | { status: 'none'; reason: 'no_target' };

/** Manifest `display` hints, a sibling of `preview` on the same tool
 *  override — purely cosmetic, every field optional. */
export interface ToolDisplayHints {
  order?: string[];
  money?: string[];
  currencyField?: string;
  percent?: string[];
  hidden?: string[];
  /**
   * Field path -> label — the manifest is the one place for display, for
   * Suveren's own AND third-party connectors; a connector's own JSON Schema
   * `title` is only a fallback when this says nothing, a humanized key the
   * last fallback. Path grammar: `"<key>"` (top-level bound field),
   * `"<key>.<subKey>"` (a NON-forEach attach's own field),
   * `"<key>[].<elementField>"` (a forEach field's own bound element field),
   * `"<key>[].<attach>"` (a forEach's attach identity column itself),
   * `"<key>[].<attach>.<sub>"` (a forEach attach's own field).
   */
  labels?: Record<string, string>;
}

/** One declared read's outcome within a multi-read preview. */
export interface PreviewReadSection {
  tool: string;
  /** See ToolPreviewConfig-style `attach` — non-`forEach` reads only: the
   *  bound action-arg name this read's result enriches. */
  attach?: string;
  /** Present only for a `forEach` read — the bound action-arg name (an
   *  array) this read ran once per element of. */
  forEach?: string;
  /** Rendering aid — the single bound field (non-`forEach`) or bound
   *  element field (`forEach`) this read's own `args` named — so the UI can
   *  tell which of the bound element's own fields the attach column
   *  replaces, instead of showing it twice. */
  sourceArg?: string;
  fields?: string[];
  /** Non-`forEach` reads only. */
  result?: PreviewReadOutcome;
  /** `forEach` reads only — one outcome per (capped) source element, same order. */
  elements?: PreviewReadOutcome[];
  overflow?: { shown: number; total: number };
  version?: PreviewVersionInfo;
}

/** `GET /proposal-status/:id/preview` — always 200 unless auth/proposal fetch fails. */
export type PreviewResponse =
  | { status: 'none'; reason?: 'no_target' }
  | { status: 'unavailable'; reason: 'no_connector' | 'connector_error' | 'timeout'; message?: string }
  | { status: 'not_found'; message?: string }
  | {
      status: 'ok';
      integration: string;
      tool: string;
      readAt: number;
      body: PreviewBody;
      version?: PreviewVersionInfo;
      /** Manifest-declared `preview.fields` — the top-level fields to show
       *  first, in that order (see tool-gating-types.ts ToolPreviewConfig). */
      fields?: string[];
    }
  /** AU8 — several reads (manifest `preview` is a list). Distinguished from
   *  the single-read "ok" above by `reads` (never both on the same object). */
  | { status: 'ok'; integration: string; readAt: number; reads: PreviewReadSection[]; display?: ToolDisplayHints };

/** `GET /proposal-status/:id/outcome` — the local execution journal's latest entry. */
export interface OutcomeResponse {
  state: 'none' | 'intent' | 'done' | 'failed';
  outcome?: 'refused' | 'changed';
  detail?: string;
  at?: number;
}

// ─── AU10 — Request + History (doc/au10-request-context.md) ───────────────

export interface RequestChainItem {
  author?: string;
  at?: string;
  title?: string;
  body?: string;
}

export type RequestResult =
  | { status: 'none' }
  | { status: 'unreadable'; reason: string }
  | { status: 'not_found' }
  | {
      status: 'ok';
      connector: string;
      kind: string;
      implicit: boolean;
      author?: string;
      at?: string;
      title?: string;
      body?: string;
      chain: RequestChainItem[];
    };

export interface HistoryItem {
  kind?: string;
  title?: string;
  body?: string;
  at?: string;
  author?: string;
  type?: string;
  aiWritten?: { at?: number };
}

export interface ConnectorHistoryMatch {
  connectorId: string;
  matchedKeyType: 'email' | 'email_domain';
  matchedKeyValue: string;
  items: HistoryItem[];
}

export type HistoryResult =
  | { status: 'no_customer_link' }
  | { status: 'no_match' }
  | { status: 'unreachable'; connectorIds: string[] }
  | { status: 'ok'; matches: ConnectorHistoryMatch[]; unreachableConnectorIds: string[] };

/** `GET /proposal-status/:id/request-context` response. */
export interface RequestContextResponse {
  request: RequestResult;
  history: HistoryResult;
}

// ─── AU10 §8.4 — "What you saw" snapshot ───────────────────────────────────

/**
 * Exactly what the approval card rendered at decision time — the AU8 preview
 * result, the AU10 request/history result, the bound values the preview
 * merges them with (`toolArgs`/`sealed` — PreviewBoxBody needs both to
 * reproduce the SAME "What will be created" box, see PreviewBox.tsx), and
 * the one read time shown on the card (doc §3: "Read time shown once").
 * Sent to the control plane on approve/change-needed/reject so it can hash
 * and store it (§8.4) — never re-read there, so no second read can
 * disagree with what was shown.
 */
export interface ShownSnapshotPayload {
  readAt: number;
  preview: PreviewResponse;
  requestContext: RequestContextResponse;
  /** The proposal's own bound args, as decrypted on THIS device — absent
   *  when undecryptable (never reachable in practice: the decision buttons
   *  are hidden until this is readable, see use-proposal-content.ts
   *  `decisionButtonsVisible`). */
  toolArgs?: Record<string, unknown>;
  sealed?: boolean;
}

/** `GET /proposal-status/:id/shown-snapshot` — the ticket view's "What you saw". */
export type ShownSnapshotResponse =
  | { status: 'off_device' }
  | { status: 'ok'; snapshot: ShownSnapshotPayload; shownHash: string; storedAt: number; verifiedLocally: boolean };

/**
 * One decider's recorded `shown_hash`, as the Authority Server stores it —
 * see `Proposal.shownHashes`'s doc comment for the key shapes. Mirrors
 * suveren-as's `ShownHashEntry` (proposal-store.ts) field for field.
 */
export interface ShownHashEntry {
  hash: string;
  by: string;
  at: number;
}

export type ShownHashes = Record<string, ShownHashEntry>;

export interface AuthTemplate {
  name: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
  mode: 'automatic' | 'review';
  bounds: Record<string, string>;
  context: Record<string, string>;
  intent: string;
  ttl: number;
  tags: string[];
}

export interface IntegrationManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Starter text the mandate screen seeds the intent with (the person edits it). */
  intentHint?: string;
  icon: string;
  profile: string;
  mcp: { command: string; args: string[]; env?: Record<string, string> };
  credentials: {
    fields: Array<{ key: string; label: string; type: 'text' | 'password'; placeholder?: string; optional?: boolean }>;
    envMapping: Record<string, string>;
  };
  oauth: {
    authUrl: string;
    tokenUrl: string;
    scopes: string[];
    credentialKeys: Record<string, string>;
    tokenStorage: string;
    extraParams?: Record<string, string>;
  } | null;
  /** Per-tool gating. Typed only where the UI reads it — `actionLabel` names
   *  what a tool DOES, in words, for the receipts list. */
  toolGating?: {
    overrides?: Record<string, { actionLabel?: string } | null>;
  } | null;
  /** Declares a simulation mode: the credential field holding it and its default. Drives the "Simulation" badge. */
  simulation?: { field: string; default: string } | null;
  /** Links the approval card offers so a reviewer can inspect the action. */
  proposalLinks?: Array<{ label: string; template: string; description?: string }>;
  templates?: AuthTemplate[];
  setupHint?: string;
  setupGuide?: Array<{ title: string; description: string; link?: string }>;
  /** Declares which context-scope fields can be discovered from the target service (wizard-only). */
  contextDiscovery?: Record<string, {
    baseUrl: string;
    endpoint: string;
    auth: 'bearer';
    credential?: string;
    responsePath: string;
    valueField: string;
    labelField: string;
    extraFields?: Record<string, string>;
  }>;
}

export interface McpIntegrationStatus {
  id: string;
  name: string;
  running: boolean;
  toolCount: number;
  /** A REAL problem (crash, failed spawn, etc). Never set for the simulation
   *  block — see `paused`, which is structural, not an error. */
  error?: string;
  /**
   * Set instead of `error` when this connector is not running SOLELY because
   * simulation mode is on and its manifest declares no `simulation` marker.
   * Paused-by-design, not broken — drives the neutral "Paused" chip and keeps
   * it out of "Needs your attention" (see IntegrationStatusContext).
   */
  paused?: 'simulation';
  /**
   * Local read-age window in days, or null when unset (reads then fall back to
   * the signed grant bound). `0` means "read nothing" and is NOT the same as
   * null — never collapse them with a truthiness check.
   */
  readAgeDays?: number | null;
}

export interface GateContentEntry {
  authorizationId: string;
  boundsHash?: string;
  contextHash?: string;
  path: string;
  profileId: string;
  gateContent: { intent: string };
  context?: Record<string, string | number>;
  /** Discovered display names per context field (value → label). */
  contextLabels?: Record<string, Record<string, string>>;
  storedAt: string;
}

/** An active authorization enriched with its local context (scope). */
export interface EnrichedAuthorizationEntry {
  profileId: string;
  authorizationId: string;
  bounds: Record<string, string | number>;
  context: Record<string, string | number>;
  intent: string | null;
  deferredCommitmentDomains: string[];
  /** v0.7 item 9 — the AS no longer verifies this mandate's protocol
   *  version (a VERSION_UNSUPPORTED ticket refusal). Learned lazily by the
   *  gateway, only once an execution was actually attempted under it. */
  needsReapproval?: boolean;
}

/** The owner's standing identity-disclosure choice, as the Authority Server holds it. */
export interface IdentityDisclosure {
  always: boolean;
  verified: boolean;
  name: string | null;
  method: string | null;
  verifier: string | null;
  verified_at: number | null;
}

/**
 * RJ1–RJ6 (temp/briefs/rj-reject-brief.md, decision 2): the three ways a
 * pending proposal can end without executing. `rejected` = no, don't retry.
 * `change_needed` = not like this — the AI may adjust and propose again.
 * `replaced` = "Edit before signing" — the person signed their own version;
 * nothing here was a refusal at all. A row with no `outcome` predates this
 * feature and reads as `rejected` (the brief's stated default).
 */
export type ProposalOutcome = 'rejected' | 'change_needed' | 'replaced';

/** PE1 — a proposal's content, sealed: HPKE broadcast over JCS(toolArgs). */
export interface ProposalContentWire {
  v: 1;
  alg: string;
  ciphertext: string;
  keys: Record<string, { ct: string; enc: string }>;
  hash: string;
}

/** PE1 — a sealed change-needed note (same shape, no `v`/`alg`/`hash` — see encrypt-proposal-note.ts). */
export interface NoteEncryptedWire {
  ciphertext: string;
  keys: Record<string, { ct: string; enc: string }>;
}

export interface Proposal {
  id: string;
  authorizationId: string;
  profileId: string;
  path: string;
  pendingDomains: string[];
  committedBy: Record<string, { userId: string; at: number }>;
  rejectedBy: { domain: string; userId: string; at: number; outcome?: ProposalOutcome; note?: string; noteEncrypted?: NoteEncryptedWire } | null;
  tool: string;
  /** PE1: present only on a legacy (pre-encryption) row — see `content`. */
  toolArgs?: Record<string, unknown>;
  /** PE1: the sealed toolArgs — present iff `toolArgs` is absent. Decrypt via lib/use-proposal-content.ts. */
  content?: ProposalContentWire;
  /** PE1: the fingerprint over JCS(toolArgs) — present on every row, legacy or encrypted. */
  contentHash?: string;
  /**
   * AU10 §8.4 — one entry PER DECIDER: the resolve flow (a team domain
   * commits/rejects) keys its entry `domain:<domain>`, the above-cap
   * approve/reject flow keys ITS entry `approver:<userId>` — both share
   * this one map because a `review_above_cap` mandate can carry both a
   * pending domain and pending approvers at once (suveren-as
   * proposal-store.ts `ShownHashes`/`shownHashKey`). `by`/`at` are always
   * the deciding user id / unix seconds regardless of which key shape was
   * used. First write per key wins — never overwritten by a later resolve.
   * Absent entirely on a row decided before this feature, or still pending.
   */
  shownHashes?: ShownHashes;
  executionContext: Record<string, string | number>;
  /**
   * `refused` (2026-10-12 fix): the Authority Server refused the ticket for
   * an APPROVED proposal — a bound exceeded after approval — so it can never
   * be executed. See `refusal` and `apps/mcp-server/src/lib/sp-client.ts`'s
   * matching field for why this is distinct from a human `rejected` decision.
   */
  status: 'pending' | 'committed' | 'rejected' | 'expired' | 'executed' | 'refused';
  executionResult: unknown | null;
  createdAt: number;
  expiresAt: number;
  /** Set iff status === 'refused' — the AS's own code/message for why. */
  refusal?: { code: string; message: string; at: number };
  // Phase 6 fields
  pendingApprovers?: string[];
  approvedBy?: Record<string, { receiptId: string; at: number }>;
  approverRejectedBy?: { userId: string; reason?: string; at: number; outcome?: ProposalOutcome; note?: string; noteEncrypted?: NoteEncryptedWire };
  createdBy?: string;
}

export interface ExecutionReceipt {
  id: string;
  groupId: string;
  userId: string;
  attestationHash: string;
  /** Per-ceremony grant id — the key for joining local context/intent. */
  authorizationId?: string;
  profileId: string;
  path: string;
  action: string;
  /** Bounds-level category driving cumulative bucketing. */
  actionType?: string;
  /** Effective limits at issuance — pairs with cumulativeState for "2 of 5". */
  limits?: Record<string, string | number>;
  executionContext: Record<string, unknown>;
  cumulativeState: {
    daily: { amount: number; count: number };
    monthly: { amount: number; count: number };
  };
  timestamp: number;
  signature: string;
  /** Present only on receipts produced via a committed proposal (review mode). */
  proposalId?: string;
  /** Level-2 content proof. Present only when the profile declares content_binding. */
  contentHash?: string;
  contentBinding?: { version: string; kind: 'jcs' | 'text'; fields?: string[] };
  // AU10 §8.4 — `shownHashes` lives on the PROPOSAL, not the receipt (the
  // Authority Server's receipts-store.ts carries no such field): a ticket
  // that ran via review mode looks it up via `proposalId` + `getProposal`.
}

/**
 * Per-grant values held locally (never at the Authority Server, which has
 * only their hashes). `archived` distinguishes the durable evidence copy from
 * the live gate store.
 */
export interface LocalAuthorization {
  authorizationId: string;
  profileId?: string;
  boundsHash?: string;
  contextHash?: string;
  bounds?: Record<string, string | number>;
  context?: Record<string, string | number>;
  intent?: string;
  archived: boolean;
}

/**
 * Whether a receipt's Ed25519 signature checked out ON THIS MACHINE, against
 * the issuer key archived when it was issued.
 *
 * `unverifiable` (no archived key) is kept distinct from `invalid` (the check
 * ran and failed): showing "no key" as a failure would cry tamper, and showing
 * a failure as "no key" would hide one.
 */
export type SignatureStatus = 'valid' | 'valid-legacy' | 'invalid' | 'unverifiable';

/** One receipt-archive entry: the signed receipt as issued, plus its grant. */
export interface LocalReceiptEntry {
  entry: {
    archivedAt: number;
    authorizationId: string;
    asUrl: string;
    asPublicKey?: string;
    receipt: Record<string, unknown>;
    proposal?: Record<string, unknown>;
    boundContent?: Record<string, unknown> | string;
  };
  authorization: LocalAuthorization | null;
  signature: SignatureStatus;
}

/** A window of receipts plus a cursor for loading the next (older) window. */
export interface ReceiptPage {
  receipts: ExecutionReceipt[];
  /** Pass back as `before` to load older receipts; null when none remain. */
  nextBefore: string | null;
}

// ─── Report (evidence-backed reports) ───────────────────────────────────────
// Mirrors apps/mcp-server/src/lib/report/types.ts — the gateway's contract
// for the one current report. Kept as a parallel type here (not imported
// cross-app) the same way every other evidence shape in this file is: the UI
// never imports server code directly.

export type ReportElementStatus = 'verified' | 'unverifiable' | 'warning';

export interface ReportElement {
  id: string;
  kind: string;
  attrs: Record<string, string>;
  status: ReportElementStatus;
  reason?: string;
  data?: Record<string, unknown>;
}

export interface ReportProof {
  ticketsReferenced: string[];
  signaturesValid: number;
  recordsChecked: number;
  unverifiableCount: number;
  verifiedValues: Array<{ elementId: string; kind: string; summary: string }>;
}

export interface ReportCoverage {
  /** Set when the email simulator export could not be read at all — cases
   *  below are UNKNOWN, not zero; never render "0 of 0" as "fully covered". */
  emailExportError?: string;
  loadedCases: string[];
  coveredCases: string[];
  missingCases: string[];
  periodStart: number | null;
  ticketsInPeriod: string[];
  ticketsReferenced: string[];
  ticketsNotReferenced: string[];
}

/** One resolved fact (a ticket, an approval, or a mandate) for the detail panel. */
export interface ResolvedFact {
  status: 'verified' | 'unverifiable';
  reason?: string;
  data?: Record<string, unknown>;
}

export interface TicketDetail {
  ticket: ResolvedFact;
  approval: ResolvedFact;
  mandate: ResolvedFact;
}

export interface ReportModel {
  savedAt: number;
  checkedAt: number;
  /** Already server-rendered: every sv-* element replaced with drawn markup.
   *  Translation off (the default). */
  renderedHtml: string;
  /** The same render with the AI's glossary shown as glosses — present only
   *  when at least one gloss is drawn (two-tag rule, RR6). */
  renderedHtmlGloss?: string;
  /** The AI's glossary: which terms are shown, which were refused. */
  glossary?: { lang: string; applied: string[]; rejected: Array<{ key: string; reason: string }> };
  /** Set when the stored report predates the two-tag rule and blocks of it
   *  are not shown (RR6). */
  formatNotice?: { blocksNotShown: number };
  proof: ReportProof;
  coverage: ReportCoverage;
  elements: ReportElement[];
  /** Full detail for every ticket id the report proves it referenced —
   *  keyed by ticket id, for the detail panel (?element=&ticket=). */
  ticketDetails: Record<string, TicketDetail>;
}

/**
 * Per-profile team configuration (admin-set).
 * Mirrors suveren-as/src/lib/profile-config-store.ts — do not import from there.
 */
export interface DifferentAccountSummary {
  credentialCount: number;
  serviceCount: number;
  credentialIds: string[];
}

/**
 * Thrown by spClient.login() when the new API key would wipe an existing
 * vault that belongs to a different user. The caller is expected to confirm
 * via UI and retry login with `{ confirmWipe: true }`.
 */
export class DifferentAccountError extends Error {
  readonly summary: DifferentAccountSummary;
  constructor(summary: DifferentAccountSummary) {
    super('different_account');
    this.name = 'DifferentAccountError';
    this.summary = summary;
  }
}

/**
 * TR5 (work-plan "Added 2026-10-14 — Team: permissions, above-cap approval,
 * read limits"; direction: content/0.7/review.md "Group roles: who may
 * grant, who approves above the cap"): whether an above-cap request on this
 * field is refused outright at signing time (`hard`) or promoted into a
 * signed `review_above_cap` mandate that a run-time approver can clear
 * (`approval`). Mirrors suveren-as's `CapKind` — do not import from there.
 */
export type CapKind = 'hard' | 'approval';

/**
 * Per-profile team configuration (admin-set). TR5 splits the single
 * `approvers` role (grant + above-cap control conflated) into `grantors`
 * (who may SIGN a mandate) and `approvers` (who may clear an above-cap
 * proposal), adds `approvals` (distinct approvals needed), and gives each
 * cap a `kind`.
 *
 * Wire shape (suveren-as fix/profile-config-compat, branch merged after
 * #86 broke every installed gateway's numeric cap comparison by nesting
 * `caps` values in `{value, kind}` objects): `caps` stays the OLD plain
 * `Record<string, number | string>` shape; `kind` travels in a SEPARATE
 * `capKinds` field. Read a cap's value from `caps[field]` and its kind from
 * `capKinds?.[field]` — NEVER assume `caps[field]` is an object. A config
 * from an AS that predates `capKinds` entirely (or a cap this admin set
 * before TR5 shipped) omits the entry for that field; `effectiveCapKind`
 * below is the one place that resolves the fallback.
 */
export interface ProfileConfig {
  /** Who may grant (sign) this profile for the team. `'all'` = every member.
   *  Absent → falls back to `approvers` (pre-TR5 behaviour). */
  grantors?: string[] | 'all';
  /** userIds who may approve an above-cap proposal. May be empty — with no
   *  approvers every cap collapses to hard. */
  approvers: string[];
  /** Distinct approvals needed before an above-cap proposal commits.
   *  Absent → defaults to 1 ("one approval is enough"). */
  approvals?: number;
  /** Per-bound cap VALUE. Key = bound field name. Plain number/string — the
   *  pre-TR5 shape, kept so an installed gateway's existing numeric
   *  comparisons keep working unchanged. */
  caps?: Record<string, number | string>;
  /** Per-bound cap KIND (TR5), keyed the same as `caps`. Absent per-field
   *  (or absent entirely, from an AS that predates it) — see
   *  `effectiveCapKind`'s fallback. */
  capKinds?: Record<string, CapKind>;
}

/** `config.grantors`, defaulted — mirrors suveren-as's `effectiveGrantors`. */
export function effectiveGrantors(config: Pick<ProfileConfig, 'grantors' | 'approvers'>): string[] | 'all' {
  return config.grantors ?? config.approvers;
}

/** `config.approvals`, defaulted — mirrors suveren-as's `effectiveApprovals`. */
export function effectiveApprovals(config: Pick<ProfileConfig, 'approvals'>): number {
  return config.approvals ?? 1;
}

export interface McpHealthResponse {
  status: string;
  transports: string[];
  sp: string;
  activeSessions: number;
  storedGates: number;
  serviceCredentials: string[];
  integrations: McpIntegrationStatus[];
  /** The gateway's own tool groups (built-ins). Absent on gateways before they existed. */
  builtins?: BuiltinStatus[];
}

/**
 * Has a person's AI ever connected to this gateway, and which one? `null` =
 * never. Backed by a file on disk (mcp-server's AgentContactStore), not a live
 * session count: closing Claude Desktop between visits must not make the
 * dashboard forget it was ever connected. See apps/mcp-server/src/lib/agent-contact.ts.
 */
export interface AgentContact {
  clientName: string;
  clientVersion?: string;
  /** ISO 8601. */
  firstSeenAt: string;
  lastSeenAt: string;
}

/** A built-in tool group of the gateway, as /health reports it. */
export interface BuiltinStatus {
  id: string;
  name: string;
  description: string;
  /** Profile governing its tools (full id or short name). */
  profile: string;
  /** Starter text the mandate screen seeds the intent with (the person edits it). */
  intentHint?: string;
  /** Usable right now — false e.g. for test-setup tools outside simulation mode. */
  available: boolean;
}

/**
 * The approvers' public keys from the AS, which answers
 * `{ pubkeys: { <userId>: <base64 key> } }`. This used to read `data.approvers`,
 * a field the AS never sends — so the list was always empty and the sign page
 * silently skipped encrypting the intent for a team's approvers.
 */
/**
 * A human-readable message from a failed response body, for every call this
 * client makes. v0.7 protocol refusals (attest, revoke, …) answer the spec
 * envelope `{ approved: false, errors: [{ code, message, field? }] }` — read
 * `errors[0]` first. Control-plane-local endpoints (vault, groups, settings,
 * integrations, …) still answer the legacy `{ error }` / `{ detail }` shape;
 * those are the fallback, never the primary read, so a protocol refusal is
 * never silently swallowed into "Failed: 422". One place for every caller
 * below, instead of re-deriving this per method (and re-missing the new
 * envelope per method, which is exactly how this bug happened).
 */
export function asErrorMessage(body: unknown, fallback: string): string {
  const b = (body ?? {}) as {
    errors?: Array<{ code?: string; message?: string }>;
    error?: string;
    detail?: string;
  };
  const first = Array.isArray(b.errors) ? b.errors[0] : undefined;
  if (first?.message) return first.code ? `${first.message} (${first.code})` : first.message;
  if (first?.code) return first.code;
  return b.error || b.detail || fallback;
}

export function parseApproverPubkeys(data: unknown): Array<{ userId: string; publicKey: string }> {
  const map = (data as { pubkeys?: unknown })?.pubkeys;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.entries(map as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0)
    .map(([userId, publicKey]) => ({ userId, publicKey }));
}

class SPClient {
  private apiKey: string | null = null;

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  clearApiKey(): void {
    this.apiKey = null;
  }

  /**
   * Used by EventSource (which can't send custom headers) to authenticate the
   * /events stream via a query-string token. Returns null if not logged in.
   */
  getApiKey(): string | null {
    return this.apiKey;
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
        ...init?.headers,
      },
    });
  }

  // ─── Auth ─────────────────────────────────────────────────────────────

  /**
   * Custom error for the "logging in with a different API key would wipe
   * the local vault" case. The UI catches this and shows a confirmation
   * modal listing the consequences before retrying with confirmWipe: true.
   */
  // (defined at module scope below — re-exported)

  async login(apiKey: string, opts: { confirmWipe?: boolean } = {}): Promise<SPUser> {
    const res = await this.fetch('/auth/login', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmWipe: opts.confirmWipe === true }),
    });
    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      if (data?.wouldWipe) {
        throw new DifferentAccountError(data.summary ?? { credentialCount: 0, serviceCount: 0, credentialIds: [] });
      }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Invalid API key' }));
      throw new Error(asErrorMessage(err, `Login failed: ${res.status}`));
    }
    const data = await res.json();
    return data.user;
  }

  async logout(): Promise<void> {
    await this.fetch('/auth/logout', { method: 'POST' });
  }

  // ─── SP proxy ─────────────────────────────────────────────────────────

  async getGroups(): Promise<SPGroup[]> {
    const res = await this.fetch('/api/groups');
    if (!res.ok) throw new Error(`Failed to fetch groups: ${res.status}`);
    const data = await res.json();
    return data.groups ?? data;
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    const res = await this.fetch('/api/profiles');
    if (!res.ok) throw new Error(`Failed to fetch profiles: ${res.status}`);
    const data = await res.json();
    return data.profiles;
  }

  async getProfile(id: string) {
    const res = await this.fetch(`/api/profiles/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Failed to fetch profile: ${res.status}`);
    return res.json();
  }

  async attest(body: {
    /** Per-ceremony identity, minted by the caller at ceremony start. */
    authorization_id: string;
    /** Renew an existing grant: same id, same content, extended expiry. */
    renew?: boolean;
    /** Edit lineage: the authorization_id this ceremony supersedes (provenance only). */
    replaces?: string;
    profile_id: string;
    /** v0.7 — the content address of the AS's own provisioned bytes for
     *  this profile_id (protocol.md -> Profile hash); required. */
    profile_hash: string;
    /** v0.7 — version negotiation (protocol.md -> Version negotiation);
     *  required. A gateway/UI speaking only pre-0.7 omits this and the AS
     *  answers VERSION_UNSUPPORTED, "re-approve this mandate". */
    supported_versions: string[];
    // v0.4
    bounds?: Record<string, string | number>;
    bounds_hash?: string;
    /** v0.7 (was `context_hash`). */
    scope_hash?: string;
    // common
    domain: string;
    did: string;
    /** v0.7 — exactly one entry today (no owner cosigning from this UI
     *  yet); the AS falls back to `{ did }` alone when omitted, but this
     *  states it explicitly rather than relying on that default. */
    mandate_owners?: Array<{ did: string }>;
    gate_content_hashes: Record<string, string>;
    execution_context_hash: string;
    group_id: string;
    ttl?: number;
    commitment_mode: 'automatic' | 'review' | 'review_above_cap';
    title?: string;
    // Phase 5 — E2EE intent (all optional; if any present, all three required)
    intent_ciphertext?: string;
    encrypted_keys?: Record<string, { ct: string; enc: string }>;
    approvers_frozen?: string[];
    // v0.5 — intent disclosure cross-check (defense-in-depth; AS recomputes and rejects mismatch)
    intent_disclosure_hash?: string;
    // v0.6 — Identity Assurance: disclose the owner's verified name on this
    // authority's actions. The AS stamps a signed `subjects` block only when this
    // is true AND the account is `high`-verified; the name then shows in the footer.
    disclose_identity?: boolean;
  }): Promise<AttestResponse> {
    const res = await this.fetch('/api/as/mandate', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(asErrorMessage(err, `Signing failed: ${res.status}`));
    }
    return res.json();
  }

  async getPending(domain: string): Promise<PendingItem[]> {
    const res = await this.fetch(`/api/mandates/pending?domain=${encodeURIComponent(domain)}`);
    if (!res.ok) throw new Error(`Failed to fetch pending: ${res.status}`);
    const data = await res.json();
    return data.pending ?? data;
  }

  async getMyAttestations(status?: string): Promise<PendingItem[]> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await this.fetch(`/api/mandates/mine${qs}`);
    if (!res.ok) throw new Error(`Failed to fetch attestations: ${res.status}`);
    const data = await res.json();
    // Normalize mine response to PendingItem shape
    return (data.mandates ?? []).map((a: Record<string, unknown>) => ({
      authorization_id: a.authorization_id,
      profile_id: a.profileId,
      path: a.path,
      title: a.title ?? null,
      sp_status: (a.status as string) ?? null,
      frame: a.bounds ?? a.frame ?? {},
      required_domains: a.requiredDomains ?? [],
      attested_domains: a.attestedDomains ?? [],
      missing_domains: (a.requiredDomains as string[] ?? []).filter(
        (d: string) => !(a.attestedDomains as string[] ?? []).includes(d)
      ),
      deferred_commitment_domains: a.deferredCommitmentDomains ?? [],
      approvers_frozen: (a.approversFrozen as string[]) ?? [],
      above_cap: (a.aboveCap as boolean) ?? false,
      created_at: a.createdAt ? new Date((a.createdAt as number) * 1000).toISOString() : '',
      earliest_expiry: (a.attestations as Array<{expiresAt: number}> | undefined)?.length
        ? new Date(Math.min(...(a.attestations as Array<{expiresAt: number}>).map(att => att.expiresAt)) * 1000).toISOString()
        : null,
      remaining_seconds: (a.attestations as Array<{expiresAt: number}> | undefined)?.length
        ? Math.max(0, Math.min(...(a.attestations as Array<{expiresAt: number}>).map(att => att.expiresAt)) - Math.floor(Date.now() / 1000))
        : null,
    }));
  }

  /**
   * Read-denial log (control-plane `GET /denials`). Blocks the Gatekeeper made
   * on reads — for the "Recent blocks" panel. Records carry no message content.
   */
  async getDenials(options?: { since?: number; limit?: number }): Promise<{ count: number; records: DenialRecord[] }> {
    const params = new URLSearchParams();
    if (options?.since) params.set('since', String(options.since));
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await this.fetch(`/denials${qs}`);
    if (!res.ok) throw new Error(`Failed to fetch denials: ${res.status}`);
    return res.json();
  }

  async getMyReceipts(options?: { date?: string; profile?: string; limit?: number }): Promise<ExecutionReceipt[]> {
    const params = new URLSearchParams();
    if (options?.date) params.set('date', options.date);
    if (options?.profile) params.set('profile', options.profile);
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    const res = await this.fetch(`/api/tickets/mine${qs ? '?' + qs : ''}`);
    if (!res.ok) throw new Error(`Failed to fetch receipts: ${res.status}`);
    const data = await res.json();
    return data.tickets ?? [];
  }

  /**
   * Fetch the evidence bundle from the control-plane: the LOCAL receipt
   * archive (complete signed receipts + attestation blobs + intent/context)
   * merged with a best-effort AS export. Authenticated — goes through
   * this.fetch so the X-API-Key header is attached.
   */
  async fetchEvidenceBundle(): Promise<{ bundle: Record<string, unknown>; filename: string }> {
    const res = await this.fetch('/api/evidence-export');
    const bundle = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(asErrorMessage(bundle, `Export failed (${res.status})`));
    }
    const filename =
      /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
      'suveren-evidence.json';
    return { bundle, filename };
  }

  /**
   * Per-grant LOCAL values (context, intent, bounds) held on this machine.
   * The AS has only their hashes, so this is the only source for the readable
   * mandate on a receipt card. Keyed by authorizationId.
   */
  async getLocalAuthorizations(): Promise<{
    authorizations: Record<string, LocalAuthorization>;
    signatures: Record<string, SignatureStatus>;
  }> {
    const res = await this.fetch('/api/evidence/authorizations');
    if (!res.ok) throw new Error(`Local evidence unavailable (${res.status})`);
    const data = await res.json();
    return { authorizations: data.authorizations ?? {}, signatures: data.signatures ?? {} };
  }

  /**
   * The verbatim archive entry for one receipt — the complete signed receipt
   * plus the attestation blobs and issuer key held on this device. Returns
   * null when no local copy exists (older receipt, or another device).
   */
  async getArchivedReceipt(receiptId: string): Promise<LocalReceiptEntry | null> {
    const res = await this.fetch(`/api/evidence/receipt/${encodeURIComponent(receiptId)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Local evidence unavailable (${res.status})`);
    return (await res.json()) as LocalReceiptEntry;
  }

  // ─── Report (evidence-backed reports) ──────────────────────────────────

  async getReport(): Promise<{ report: ReportModel | null }> {
    const res = await this.fetch('/api/report');
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Report unavailable (${res.status})` }));
      throw new Error(asErrorMessage(err, `Report unavailable (${res.status})`));
    }
    return res.json();
  }

  async saveReport(html: string): Promise<{ report: ReportModel }> {
    const res = await this.fetch('/api/report', { method: 'POST', body: JSON.stringify({ html }) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Save failed (${res.status})` }));
      throw new Error(asErrorMessage(err, `Save failed (${res.status})`));
    }
    return res.json();
  }

  async recheckReport(): Promise<{ report: ReportModel | null }> {
    const res = await this.fetch('/api/report/recheck', { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Recheck failed (${res.status})` }));
      throw new Error(asErrorMessage(err, `Recheck failed (${res.status})`));
    }
    return res.json();
  }

  /**
   * "Export with proof" (work-plan R6) — a self-contained HTML file, so this
   * reads text + the filename from Content-Disposition rather than JSON
   * (same pattern as `fetchEvidenceBundle` above).
   */
  async exportReportWithProof(): Promise<{ html: string; filename: string }> {
    const res = await this.fetch('/api/report/export');
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Export failed (${res.status})` }));
      throw new Error(asErrorMessage(err, `Export failed (${res.status})`));
    }
    const html = await res.text();
    const filename =
      /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
      'suveren-report.html';
    return { html, filename };
  }

  async revokeAttestation(authorizationId: string, reason?: string): Promise<void> {
    const res = await this.fetch(`/api/authorizations/${encodeURIComponent(authorizationId)}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason ?? 'Revoked by user' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to revoke' }));
      throw new Error(asErrorMessage(err, `Revoke failed: ${res.status}`));
    }
  }

  async getAttestations(authorizationId: string): Promise<AttestationsResult> {
    const res = await this.fetch(`/api/mandates?authorization_id=${encodeURIComponent(authorizationId)}`);
    if (!res.ok) throw new Error(`Failed to fetch attestations: ${res.status}`);
    // v0.7: the response key is `mandates` (was `attestations`) — map onto
    // this client's own stable field name at the boundary.
    const body = await res.json();
    return { ...body, attestations: body.mandates ?? body.attestations ?? [] };
  }

  async getGroupById(id: string): Promise<{ id: string; name: string; members: Array<{ id: string; name: string; email: string; domains: string[]; role: string }>; inviteCode?: string }> {
    const res = await this.fetch(`/api/groups/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Failed to fetch group: ${res.status}`);
    return res.json();
  }

  /**
   * Creating a team MOVES the account (work-plan "Added 2026-10-11 — an
   * account is Personal OR in one team", decision 3): the caller's
   * Personal mandates are revoked (kept as history) and its pending
   * Personal proposals are rejected. `ended` is what that cost — the SAME
   * counts {@link getCreatePreview} shows BEFORE the person confirms.
   */
  async createGroup(name: string): Promise<SPGroup & { ended: { mandates: number; proposals: number } }> {
    const res = await this.fetch('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(asErrorMessage(err, `Create group failed: ${res.status}`));
    }
    const data = await res.json();
    const g = data.group || data;
    return {
      id: g.id, name: g.name, myDomains: g.myDomains || [], isAdmin: true,
      ended: data.ended ?? { mandates: 0, proposals: 0 },
    };
  }

  /**
   * What creating a team would end for the caller (decision 3) — the
   * create screen shows this BEFORE "Create team and move my account".
   * No state change. `GET /api/groups/create/preview`.
   */
  async getCreatePreview(): Promise<PersonalEndingPreview> {
    const res = await this.fetch('/api/groups/create/preview');
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(asErrorMessage(err, `Failed to preview team creation: ${res.status}`));
    }
    return res.json();
  }

  /**
   * What joining `inviteCode`'s team would end for the caller — the join
   * screen's preview, shown BEFORE "Ask to join" even exists as a request.
   * No state change. `GET /api/groups/join/preview?inviteCode=…`.
   * 404 (invalid/expired code) surfaces as a thrown Error.
   */
  async getJoinPreview(inviteCode: string): Promise<JoinPreview> {
    const res = await this.fetch(`/api/groups/join/preview?inviteCode=${encodeURIComponent(inviteCode)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Invalid or expired invite code' }));
      throw new Error(asErrorMessage(err, `Invalid invite code: ${res.status}`));
    }
    return res.json();
  }

  /**
   * Entering an invite code no longer makes the caller a member (work-plan
   * "Added 2026-10-11"): it creates a PENDING REQUEST the team admin
   * confirms or declines. 202, not 200 — nothing has moved yet. Throws on
   * 404 (bad code), 409 (already in a team, or already has a pending
   * request — `code: 'REQUEST_PENDING'`), 403 (previously disabled in that
   * team).
   */
  async requestToJoinGroup(inviteCode: string): Promise<PendingJoinRequest> {
    const res = await this.fetch('/api/groups/join', {
      method: 'POST',
      body: JSON.stringify({ inviteCode }),
    });
    if (res.status !== 202) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(asErrorMessage(err, `Request to join failed: ${res.status}`));
    }
    const data = await res.json();
    return data.request;
  }

  /**
   * Withdraw the caller's own pending join request — the account stays
   * Personal, nothing else changes. Returns false (not an error) when there
   * was no pending request to withdraw (404) — the UI treats that as
   * already-resolved, not a failure.
   */
  async withdrawJoinRequest(): Promise<boolean> {
    const res = await this.fetch('/api/groups/join', { method: 'DELETE' });
    if (res.status === 404) return false;
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(asErrorMessage(err, `Withdraw failed: ${res.status}`));
    }
    const data = await res.json();
    return data.withdrawn === true;
  }

  async inviteToGroup(groupId: string): Promise<{ inviteCode?: string; code?: string }> {
    const res = await this.fetch(`/api/groups/${encodeURIComponent(groupId)}/invite`, {
      method: 'POST',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(asErrorMessage(err, `Invite failed: ${res.status}`));
    }
    return res.json();
  }

  /**
   * The caller's active team group + membership (null for personal-only
   * users) PLUS their own pending join request, if any (work-plan "Added
   * 2026-10-11" — mutually exclusive with an active team by construction,
   * but reported independently so the caller never has to assume that).
   * `GET /api/groups/me`.
   */
  async getMyTeam(): Promise<{ group: SPGroup | null; membership: GroupMember | null; pendingRequest: PendingJoinRequest | null }> {
    const res = await this.fetch('/api/groups/me');
    if (!res.ok) return { group: null, membership: null, pendingRequest: null };
    const data = await res.json();
    return {
      group: data.group ?? null,
      membership: data.membership ?? null,
      pendingRequest: data.pendingRequest ?? null,
    };
  }

  /**
   * List all users known to the SP. Used to resolve approver display names
   * when the per-group members endpoint isn't enriched. Returns minimal
   * profile info ({ id, name, email, did }).
   */
  async listUsers(): Promise<Array<{ id: string; name: string; email: string; did?: string }>> {
    const res = await this.fetch('/api/users');
    if (!res.ok) return [];
    const data = await res.json();
    return data.users ?? [];
  }

  async setPubkey(pubkey: string): Promise<void> {
    const res = await this.fetch('/api/users/me/pubkey', {
      method: 'PUT',
      body: JSON.stringify({ pubkey }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to set pubkey' }));
      throw new Error(asErrorMessage(err, `setPubkey failed: ${res.status}`));
    }
  }

  async getPubkey(userId: string): Promise<string | null> {
    const res = await this.fetch(`/api/users/${encodeURIComponent(userId)}/pubkey`);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = await res.json();
    return data.pubkey ?? null;
  }

  async leaveTeam(groupId: string): Promise<void> {
    const res = await this.fetch(`/api/groups/${encodeURIComponent(groupId)}/leave`, {
      method: 'POST',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to leave team' }));
      throw new Error(asErrorMessage(err, `Leave failed: ${res.status}`));
    }
  }

  // ─── Vault ────────────────────────────────────────────────────────────

  async getVaultStatus(): Promise<VaultStatus> {
    const res = await this.fetch('/vault/status');
    if (!res.ok) throw new Error(`Failed to fetch vault status: ${res.status}`);
    return res.json();
  }

  // ─── Local gateway preferences (control plane, not the Authority Server) ───

  async getGatewaySettings(): Promise<{ desktopNotifications: boolean }> {
    const res = await this.fetch('/api/gateway-settings');
    if (!res.ok) throw new Error(`Failed to load settings: ${res.status}`);
    return res.json();
  }

  /** Returns the PERSISTED state, so callers render backend truth. */
  async setGatewaySettings(patch: { desktopNotifications?: boolean }): Promise<{ desktopNotifications: boolean }> {
    const res = await this.fetch('/api/gateway-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Failed to save settings: ${res.status}`);
    return res.json();
  }

  // ─── Archived mandates (local display flag; deletes nothing) ───

  async getArchivedMandates(): Promise<string[]> {
    const res = await this.fetch('/api/archived-mandates');
    if (!res.ok) throw new Error(`Failed to load archived mandates: ${res.status}`);
    return ((await res.json()) as { archived: string[] }).archived;
  }

  /** Returns the PERSISTED list, so callers render backend truth. */
  async setMandateArchived(authorizationId: string, archived: boolean): Promise<string[]> {
    const res = await this.fetch(`/api/archived-mandates/${encodeURIComponent(authorizationId)}`, {
      method: archived ? 'PUT' : 'DELETE',
    });
    if (!res.ok) throw new Error(`Failed to ${archived ? 'archive' : 'unarchive'} mandate: ${res.status}`);
    return ((await res.json()) as { archived: string[] }).archived;
  }

  /**
   * Credential metadata. `fields` carries only manifest-declared `text` values;
   * secret fields arrive as recognition hints (prefix + last 4, or null for
   * short secrets) in `secrets`. The full values never reach the browser, and
   * there is deliberately no endpoint that returns them.
   */
  async getCredential(name: string): Promise<{
    configured: boolean;
    fieldNames?: string[];
    fields?: Record<string, string>;
    secrets?: Record<string, { preview: string | null }>;
    updatedAt?: string;
  }> {
    const res = await this.fetch(`/vault/credentials/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`Failed to check credential: ${res.status}`);
    return res.json();
  }

  async setCredential(name: string, fields: Record<string, string>): Promise<void> {
    const res = await this.fetch(`/vault/credentials/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(fields),
    });
    if (!res.ok) throw new Error(`Failed to save credential: ${res.status}`);
  }

  async testCredential(name: string): Promise<{ ok: boolean; message: string }> {
    const res = await this.fetch(`/vault/test/${encodeURIComponent(name)}`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`Test failed: ${res.status}`);
    return res.json();
  }

  // ─── AI ───────────────────────────────────────────────────────────────

  async aiAssist(request: {
    gate: 'intent';
    currentText: string;
    context?: { profileId?: string; bounds?: string };
  }): Promise<{ success: boolean; suggestion?: string; error?: string; disclaimer: string }> {
    const res = await this.fetch('/ai/assist', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'AI request failed' }));
      return { success: false, error: asErrorMessage(err, 'AI request failed'), disclaimer: 'AI surfaces reality. You supply intent.' };
    }
    return res.json();
  }

  /** On-demand semantic cross-check of a new grant's intent vs existing grants. */
  async aiIntentReview(request: {
    profileId: string;
    newIntent: string;
    context?: Record<string, string | number>;
  }): Promise<{
    success: boolean;
    review?: string | null;
    note?: string;
    error?: string;
    disclaimer?: string;
    grants?: Array<{ scope: string; intent: string | null; bounds: Record<string, string | number> }>;
  }> {
    const res = await this.fetch('/ai/intent-review', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'AI request failed' }));
      return { success: false, error: asErrorMessage(err, 'AI request failed') };
    }
    return res.json();
  }

  async aiTest(config?: { provider?: string; endpoint?: string; model?: string; apiKey?: string }): Promise<{ ok: boolean; message: string }> {
    const res = await this.fetch('/ai/test', {
      method: 'POST',
      body: JSON.stringify(config ?? {}),
    });
    if (!res.ok) throw new Error(`AI test failed: ${res.status}`);
    return res.json();
  }

  /** Fetch the live model list from the provider. Omitting apiKey falls back
   *  to the stored key server-side for the same endpoint. */
  async aiModels(config?: { provider?: string; endpoint?: string; apiKey?: string }): Promise<{ ok: boolean; models: string[]; message?: string }> {
    const res = await this.fetch('/ai/models', {
      method: 'POST',
      body: JSON.stringify(config ?? {}),
    });
    if (!res.ok) throw new Error(`Model list failed: ${res.status}`);
    return res.json();
  }

  // ─── MCP Integrations ──────────────────────────────────────────────────

  async getMcpHealth(): Promise<McpHealthResponse> {
    const res = await this.fetch('/mcp/health');
    if (!res.ok) throw new Error(`MCP server unreachable: ${res.status}`);
    return res.json();
  }

  /** See AgentContact — drives the dashboard first-run card's "Connect your AI" step. */
  async getAgentContact(): Promise<{ contact: AgentContact | null }> {
    const res = await this.fetch('/mcp/agent-contact');
    if (!res.ok) throw new Error(`Failed to fetch agent contact: ${res.status}`);
    return res.json();
  }

  async getMcpIntegrations(): Promise<{ integrations: McpIntegrationStatus[] }> {
    const res = await this.fetch('/mcp/integrations');
    if (!res.ok) throw new Error(`Failed to fetch integrations: ${res.status}`);
    return res.json();
  }

  /**
   * Auth-health probe: attempts a real token refresh server-side so the UI can
   * show whether the integration can actually authenticate (vs. just "a token
   * exists"). `failed` = the provider rejected the token (e.g. invalid_grant).
   */
  async getOAuthHealth(integrationId: string): Promise<{
    status: 'ok' | 'failed' | 'not_connected' | 'not_configured' | 'unverified';
    error?: string;
    account?: string;
  }> {
    try {
      const res = await this.fetch(`/auth/oauth/${encodeURIComponent(integrationId)}/health`);
      if (!res.ok) return { status: 'unverified' };
      return await res.json();
    } catch {
      return { status: 'unverified' };
    }
  }

  async getIntegrationManifests(): Promise<{ manifests: IntegrationManifest[] }> {
    const res = await this.fetch('/mcp/integrations/manifests');
    if (!res.ok) throw new Error(`Failed to fetch manifests: ${res.status}`);
    return res.json();
  }

  /**
   * Wizard-only scope-field discovery. Asks the control plane to fetch a
   * context-field's valid values from the connected service (e.g., Google
   * Calendar's calendarList). Returns normalized options for a multi-select.
   * See doc/hap-scope-discovery-proposal.md.
   */
  async discoverScopeField(integrationId: string, field: string): Promise<{
    options: Array<{ value: string; label: string; extras?: Record<string, unknown> }>;
  }> {
    const res = await this.fetch(
      `/integrations/${encodeURIComponent(integrationId)}/discover/${encodeURIComponent(field)}`,
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Discovery failed: ${res.status}` }));
      throw new Error(asErrorMessage(err, `Discovery failed: ${res.status}`));
    }
    return res.json();
  }

  async activateIntegration(id: string): Promise<{ ok: boolean; id: string; tools: string[]; warning?: string }> {
    const res = await this.fetch(`/mcp/integrations/${encodeURIComponent(id)}/activate`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      throw new Error(asErrorMessage(err, `Failed: ${res.status}`));
    }
    return res.json();
  }

  async removeMcpIntegration(id: string): Promise<void> {
    const res = await this.fetch(`/mcp/integrations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Failed to remove integration: ${res.status}`);
  }

  /**
   * Set how far back the agent may read on this integration. `null` clears the
   * local setting and falls back to the signed grant bound. Applies to the
   * next read — no re-authorization needed.
   */
  async setReadPolicy(id: string, readAgeDays: number | null): Promise<void> {
    const res = await this.fetch(`/integrations/${encodeURIComponent(id)}/read-policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readAgeDays }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(asErrorMessage(err, `HTTP ${res.status}`));
    }
  }

  // ─── Team Profile Config ────────────────────────────────────────────────

  /**
   * Fetch profile-level caps + approvers for a team profile.
   * Returns null on 404 (no config set for this profile).
   * Endpoint: GET /api/groups/:id/profile-config/:profileId
   */
  async getTeamProfileConfig(groupId: string, profileId: string): Promise<ProfileConfig | null> {
    const res = await this.fetch(
      `/api/groups/${encodeURIComponent(groupId)}/profile-config/${encodeURIComponent(profileId)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) return null;
    // SP wraps the config in { profileId, config } — unwrap it to match
    // the ProfileConfig type the rest of the gateway expects.
    const body = await res.json();
    return (body?.config as ProfileConfig) ?? null;
  }

  /**
   * Set (or replace) profile-level caps + approvers. Admin-only on the SP side.
   * Endpoint: PUT /api/groups/:id/profile-config/:profileId
   */
  async setTeamProfileConfig(groupId: string, profileId: string, config: ProfileConfig): Promise<void> {
    const res = await this.fetch(
      `/api/groups/${encodeURIComponent(groupId)}/profile-config/${encodeURIComponent(profileId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(config),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to set profile config' }));
      throw new Error(asErrorMessage(err, `setTeamProfileConfig failed: ${res.status}`));
    }
  }

  /**
   * Encrypt an intent for a set of recipients via the control-plane.
   * Calls POST /api/encrypt-intent (does not touch the SP; handled by CP).
   */
  async encryptIntent(
    intent: string,
    recipients: Array<{ userId: string; publicKey: string }>,
  ): Promise<{
    intentCiphertext: string;
    encryptedKeys: Record<string, { ct: string; enc: string }>;
    approversFrozen: string[];
    intentDisclosureHash: string;
  }> {
    const res = await this.fetch('/api/encrypt-intent', {
      method: 'POST',
      body: JSON.stringify({ intent, recipients }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Encryption failed' }));
      throw new Error(asErrorMessage(err, `encryptIntent failed: ${res.status}`));
    }
    return res.json();
  }

  /**
   * Fetch public keys for all current approvers on a profile.
   * Returns an array of { userId, publicKey } — only users who have registered
   * a key are included. Empty array = no approvers have keys (skip encryption).
   * Endpoint: GET /api/groups/:id/profile-config/:profileId/approvers/pubkeys
   */
  /** Argument schemas + approvalView hints per namespaced tool, for the approval screen. */
  async getToolDisplay(): Promise<Record<string, import('./approval-view').ToolDisplay>> {
    const res = await this.fetch('/tool-display');
    if (!res.ok) return {};
    const data = await res.json();
    return (data?.tools ?? {}) as Record<string, import('./approval-view').ToolDisplay>;
  }

  async getApproversPubkeys(groupId: string, profileId: string): Promise<Array<{ userId: string; publicKey: string }>> {
    const res = await this.fetch(
      `/api/groups/${encodeURIComponent(groupId)}/profile-config/${encodeURIComponent(profileId)}/approvers/pubkeys`,
    );
    if (!res.ok) return [];
    return parseApproverPubkeys(await res.json());
  }

  /**
   * Delete the profile config for a team profile. Admin-only on the SP side.
   * Endpoint: DELETE /api/groups/:id/profile-config/:profileId
   */
  async deleteTeamProfileConfig(groupId: string, profileId: string): Promise<void> {
    const res = await this.fetch(
      `/api/groups/${encodeURIComponent(groupId)}/profile-config/${encodeURIComponent(profileId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to delete profile config' }));
      throw new Error(asErrorMessage(err, `deleteTeamProfileConfig failed: ${res.status}`));
    }
  }

  // ─── Identity disclosure (standing choice) ──────────────────────────────

  async getIdentityDisclosure(): Promise<IdentityDisclosure> {
    const res = await this.fetch('/api/users/me/identity-disclosure');
    if (!res.ok) throw new Error(`Failed to read identity setting: ${res.status}`);
    return res.json();
  }

  async setIdentityDisclosure(always: boolean): Promise<IdentityDisclosure> {
    const res = await this.fetch('/api/users/me/identity-disclosure', { method: 'PUT', body: JSON.stringify({ always }) });
    if (!res.ok) throw new Error(`Failed to save identity setting: ${res.status}`);
    return res.json();
  }

  // ─── Proposals ──────────────────────────────────────────────────────────

  /** `status: 'all'` also returns proposals DECIDED in the last 7 days (rejected /
   *  sent back / replaced, as stored) — the All view's history (RJ2). An older AS
   *  ignores the parameter and returns pending only, as before. */
  async getProposals(domain: string, status: 'pending' | 'all' = 'pending'): Promise<Proposal[]> {
    const q = status === 'all' ? '&status=all' : '';
    const res = await this.fetch(`/api/proposals?domain=${encodeURIComponent(domain)}${q}`);
    if (!res.ok) throw new Error(`Failed to fetch proposals: ${res.status}`);
    const data = await res.json();
    return data.proposals ?? [];
  }

  /** The user's whole queue: the active workspace plus the personal one — see lib/my-queue. */
  async getMyProposals(activeDomain: string | null | undefined, status: 'pending' | 'all' = 'pending'): Promise<Proposal[]> {
    const lists = await Promise.all(queueDomains(activeDomain).map((d) => this.getProposals(d, status)));
    return mergeProposals(lists);
  }

  /**
   * `opts` is the RJ1–RJ6 contract (temp/briefs/rj-reject-brief.md) — only
   * meaningful with `action: 'reject'`; the AS 400s if sent with 'commit'.
   * `domain` stays a required positional argument: the AS's `/resolve` body
   * always carries it (contract, decision — unrelated to outcome/note), and
   * every existing caller already has it in hand.
   */
  async resolveProposal(
    id: string,
    action: 'commit' | 'reject',
    domain: string,
    opts?: {
      outcome?: ProposalOutcome;
      note?: string;
      /** PE1 G5 — replaces `note` when the note was sealed (change_needed). */
      noteEncrypted?: NoteEncryptedWire;
      /** PE1 — the fingerprint of the toolArgs THIS device decrypted and
       *  showed for approval/commit; the AS refuses (409 CONTENT_MISMATCH)
       *  rather than acting on a hash it does not recognize. */
      contentHash?: string;
      /** AU10 §8.4 — the hash of exactly what THIS device's card showed
       *  (preview + request/history + read time), from `saveShownSnapshot`.
       *  Nullable on the wire: an older AS ignores an unknown field. */
      shownHash?: string;
    },
  ): Promise<{ status: string }> {
    const { noteEncrypted, contentHash, shownHash, note, ...rest } = opts ?? {};
    const res = await this.fetch(`/api/proposals/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({
        action,
        domain,
        ...rest,
        // Mutually exclusive on the wire: a sealed note replaces the plain one.
        ...(noteEncrypted ? { note_encrypted: noteEncrypted } : (note ? { note } : {})),
        ...(contentHash ? { content_hash: contentHash } : {}),
        ...(shownHash ? { shown_hash: shownHash } : {}),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      throw new Error(asErrorMessage(err, `Failed: ${res.status}`));
    }
    return res.json();
  }

  // ─── Phase 6: Per-action approver proposals ─────────────────────────────

  /**
   * Fetch proposals where the caller is a required approver and has not yet approved.
   * SP endpoint: GET /api/proposals?approver=me
   */
  /** One proposal (backend truth), e.g. to pick the route that may decide it. */
  async getProposal(id: string): Promise<Proposal> {
    const res = await this.fetch(`/api/proposals/${encodeURIComponent(id)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      throw new Error(asErrorMessage(err, `getProposal failed: ${res.status}`));
    }
    const data = await res.json();
    return (data.proposal ?? data) as Proposal;
  }

  async getProposalsForApprover(): Promise<Proposal[]> {
    const res = await this.fetch('/api/proposals?approver=me');
    if (!res.ok) throw new Error(`Failed to fetch approver proposals: ${res.status}`);
    const data = await res.json();
    return data.proposals ?? [];
  }

  /**
   * Approve an above-cap action proposal.
   * SP endpoint: POST /api/proposals/:id/approve
   */
  async approveProposal(
    id: string,
    contentHash?: string,
    /** AU10 §8.4 — see {@link resolveProposal}'s matching parameter. */
    shownHash?: string,
  ): Promise<{
    receipt: Record<string, unknown>;
    status: string;
    approvedBy: Record<string, { receiptId: string; at: number }>;
    /**
     * TR5 (work-plan "Added 2026-10-14") — how many distinct approvals this
     * proposal needs, and how many it has NOW, straight from the AS's own
     * response to THIS approve call. Absent on an older AS (pre-TR5) —
     * callers must not assume these are always present, and must never
     * compute their own guess instead (UI reflects AS truth, never
     * optimistic state).
     */
    requiredApprovals?: number;
    approvedCount?: number;
    remainingApprovers?: string[];
  }> {
    const body: Record<string, string> = {};
    // PE1 — the fingerprint of the toolArgs THIS device decrypted and showed.
    if (contentHash) body.content_hash = contentHash;
    if (shownHash) body.shown_hash = shownHash;
    const res = await this.fetch(`/api/proposals/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      throw new Error(asErrorMessage(err, `approveProposal failed: ${res.status}`));
    }
    return res.json();
  }

  /**
   * Reject (above-cap approver path) or withdraw a proposal.
   * SP endpoint: POST /api/proposals/:id/reject — accepts the legacy
   * `{ reason }` body (older gateways) as well as the RJ1–RJ6 contract
   * `{ outcome?, note? }` (temp/briefs/rj-reject-brief.md). `reason` and
   * `outcome`/`note` are mutually exclusive callers in this codebase — no
   * call site here needs both at once.
   */
  async rejectProposal(
    id: string,
    opts?: string | { reason?: string; outcome?: ProposalOutcome; note?: string; noteEncrypted?: NoteEncryptedWire },
    /** PE1 — the fingerprint of the toolArgs THIS device decrypted and showed. */
    contentHash?: string,
    /** AU10 §8.4 — see {@link resolveProposal}'s matching parameter. */
    shownHash?: string,
  ): Promise<{ receipt: Record<string, unknown>; status: string }> {
    // A plain string is the legacy shape (stored as `reason`, outcome rejected).
    let body: Record<string, unknown>;
    if (typeof opts === 'string') {
      body = { reason: opts };
    } else {
      const { noteEncrypted, note, ...rest } = opts ?? {};
      body = {
        ...rest,
        // Mutually exclusive on the wire: a sealed note replaces the plain one.
        ...(noteEncrypted ? { note_encrypted: noteEncrypted } : (note ? { note } : {})),
      };
    }
    if (contentHash) body.content_hash = contentHash;
    if (shownHash) body.shown_hash = shownHash;
    const res = await this.fetch(`/api/proposals/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      throw new Error(asErrorMessage(err, `rejectProposal failed: ${res.status}`));
    }
    return res.json();
  }

  /**
   * The system's "before it runs" read for a pending proposal — gateway-
   * internal, never returned to the AI (AU3/AU5, decision 1). Control-plane
   * `GET /proposal-status/:id/preview`, not under `/api` (same convention as
   * `/denials`).
   */
  async getProposalPreview(id: string): Promise<PreviewResponse> {
    const res = await this.fetch(`/proposal-status/${encodeURIComponent(id)}/preview`);
    if (!res.ok) throw new Error(`Failed to fetch preview: ${res.status}`);
    return res.json();
  }

  /**
   * AU10 — the Request + History blocks for a pending proposal. Same
   * gateway-internal-only path as `getProposalPreview`.
   */
  async getProposalRequestContext(id: string): Promise<RequestContextResponse> {
    const res = await this.fetch(`/proposal-status/${encodeURIComponent(id)}/request-context`);
    if (!res.ok) throw new Error(`Failed to fetch request context: ${res.status}`);
    return res.json();
  }

  /**
   * AU10 §8.4 — stores exactly what this device's card rendered (the SAME
   * payload, not a fresh read) and returns its hash, to send with the
   * decision. Control-plane `POST /proposal-status/:id/shown-snapshot`.
   */
  async saveShownSnapshot(id: string, snapshot: ShownSnapshotPayload): Promise<{ shownHash: string }> {
    const res = await this.fetch(`/proposal-status/${encodeURIComponent(id)}/shown-snapshot`, {
      method: 'POST',
      body: JSON.stringify(snapshot),
    });
    if (!res.ok) throw new Error(`Failed to store the shown snapshot: ${res.status}`);
    return res.json();
  }

  /**
   * AU10 §8.4 — the ticket view's "What you saw": the local snapshot (if any
   * is on THIS device) plus the control plane's own re-hash check.
   */
  async getShownSnapshot(id: string): Promise<ShownSnapshotResponse> {
    const res = await this.fetch(`/proposal-status/${encodeURIComponent(id)}/shown-snapshot`);
    if (!res.ok) throw new Error(`Failed to fetch the shown snapshot: ${res.status}`);
    return res.json();
  }

  /**
   * What actually happened after an AS-"executed" proposal — the local
   * execution journal, which knows about a connector refusal or a changed
   * record that the AS's own status does not (AU4/AU5). Control-plane
   * `GET /proposal-status/:id/outcome`.
   */
  async getProposalOutcome(id: string): Promise<OutcomeResponse> {
    const res = await this.fetch(`/proposal-status/${encodeURIComponent(id)}/outcome`);
    if (!res.ok) throw new Error(`Failed to fetch outcome: ${res.status}`);
    return res.json();
  }

  /**
   * Fetch E2EE encrypted intent for an authority.
   * Returns the bulk ciphertext + the caller's HPKE key wrap.
   * SP endpoint: GET /api/authorizations/:id/intent
   */
  async getAttestationIntent(authorizationId: string): Promise<{
    intentCiphertext: string;
    encryptedKey: { ct: string; enc: string };
    approversFrozen: string[];
  } | null> {
    const res = await this.fetch(`/api/authorizations/${encodeURIComponent(authorizationId)}/intent`);
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) return null;
    return res.json();
  }

  /**
   * Decrypt an intent on the control-plane using the vault's private HPKE key.
   * CP endpoint: POST /api/decrypt-intent
   */
  async decryptIntent(params: {
    intentCiphertext: string;
    encryptedKey: { ct: string; enc: string };
    approverId: string;
  }): Promise<string> {
    const res = await this.fetch('/api/decrypt-intent', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Decryption failed' }));
      throw new Error(asErrorMessage(err, `decryptIntent failed: ${res.status}`));
    }
    const data = await res.json() as { intent: string };
    return data.intent;
  }

  /**
   * PE1 — decrypt a proposal's sealed content (toolArgs, JCS-encoded — the
   * caller JSON.parses the result) or a change-needed note, using the
   * vault's private HPKE key. CP endpoint: POST /api/decrypt-proposal-content.
   * Throws (never silently returns empty) on a device with no key wrap for
   * this content — callers show "Encrypted for another device" (mockup §4),
   * never a blank card.
   */
  async decryptProposalContent(wire: { ciphertext: string; keys: Record<string, { ct: string; enc: string }> }): Promise<{ plaintext: string }> {
    const res = await this.fetch('/api/decrypt-proposal-content', {
      method: 'POST',
      body: JSON.stringify(wire),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Decryption failed' }));
      throw new Error(asErrorMessage(err, `decryptProposalContent failed: ${res.status}`));
    }
    return res.json();
  }

  /**
   * PE1 G5 — encrypt a "change needed" note on this (the deciding) gateway,
   * for the submitter + mandate owner. CP endpoint: POST /api/encrypt-proposal-note.
   */
  async encryptProposalNote(note: string, recipientUserIds: string[]): Promise<{ noteEncrypted: NoteEncryptedWire; unreadableFor: string[] }> {
    const res = await this.fetch('/api/encrypt-proposal-note', {
      method: 'POST',
      body: JSON.stringify({ note, recipientUserIds }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Encryption failed' }));
      throw new Error(asErrorMessage(err, `encryptProposalNote failed: ${res.status}`));
    }
    return res.json();
  }

  /**
   * Persist a decrypted intent as an approver accountability record.
   * CP endpoint: POST /api/approved-intents
   */
  async storeApprovedIntent(authorityId: string, intent: string): Promise<void> {
    const res = await this.fetch('/api/approved-intents', {
      method: 'POST',
      body: JSON.stringify({ authorityId, intent }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      throw new Error(asErrorMessage(err, `storeApprovedIntent failed: ${res.status}`));
    }
  }

  // ─── Phase 7: Team governance views ────────────────────────────────────

  /**
   * Fetch all authorizations for a group (admin-only).
   * SP endpoint: GET /api/groups/:id/mandates (v0.7; moved from
   * .../attestations, which now answers 410).
   * Returns the standard PendingItem shape plus an `owner` field per item.
   */
  async listTeamAuthorizations(groupId: string): Promise<Array<PendingItem & { owner: { userId: string; name?: string; email?: string } }>> {
    const res = await this.fetch(`/api/groups/${encodeURIComponent(groupId)}/mandates`);
    if (!res.ok) throw new Error(`Failed to fetch team authorizations: ${res.status}`);
    const data = await res.json();
    return (data.mandates ?? []).map((a: Record<string, unknown>) => {
      const owner = (a.owner as { userId: string; name?: string; email?: string }) ?? { userId: '' };
      const item: PendingItem & { owner: { userId: string; name?: string; email?: string } } = {
        authorization_id: (a.authorization_id ?? a.authorizationId) as string,
        profile_id: (a.profileId ?? a.profile_id) as string,
        path: (a.path ?? '') as string,
        title: (a.title ?? null) as string | null,
        sp_status: (a.status ?? a.sp_status ?? null) as string | null,
        frame: (a.bounds ?? a.frame ?? {}) as Record<string, string | number>,
        required_domains: (a.requiredDomains ?? a.required_domains ?? []) as string[],
        attested_domains: (a.attestedDomains ?? a.attested_domains ?? []) as string[],
        missing_domains: ((a.requiredDomains ?? a.required_domains ?? []) as string[]).filter(
          (d: string) => !((a.attestedDomains ?? a.attested_domains ?? []) as string[]).includes(d)
        ),
        deferred_commitment_domains: (a.deferredCommitmentDomains ?? a.deferred_commitment_domains ?? []) as string[],
        approvers_frozen: (a.approversFrozen ?? a.approvers_frozen ?? []) as string[],
        above_cap: (a.aboveCap ?? a.above_cap ?? false) as boolean,
        created_at: a.createdAt ? new Date((a.createdAt as number) * 1000).toISOString() : (a.created_at as string ?? ''),
        earliest_expiry: (a.mandates as Array<{ expiresAt: number }> | undefined)?.length
          ? new Date(Math.min(...(a.mandates as Array<{ expiresAt: number }>).map(att => att.expiresAt)) * 1000).toISOString()
          : null,
        remaining_seconds: (a.mandates as Array<{ expiresAt: number }> | undefined)?.length
          ? Math.max(0, Math.min(...(a.mandates as Array<{ expiresAt: number }>).map(att => att.expiresAt)) - Math.floor(Date.now() / 1000))
          : null,
        owner,
      };
      return item;
    });
  }

  /**
   * Fetch execution receipts for a group (admin sees team-wide; others see own).
   * SP endpoint: GET /api/groups/:id/tickets (v0.7; moved from .../receipts,
   * which now answers 410).
   */
  async listTeamReceipts(groupId: string): Promise<ExecutionReceipt[]> {
    const res = await this.fetch(`/api/groups/${encodeURIComponent(groupId)}/tickets`);
    if (!res.ok) throw new Error(`Failed to fetch team receipts: ${res.status}`);
    const data = await res.json();
    return data.tickets ?? [];
  }

  /**
   * Paged receipts for the audit view. The SP walks a window of days backward
   * from `before` (a YYYY-MM-DD cursor) and returns `nextBefore` for "Load
   * older" — null once the history floor is reached. Without `before` it
   * returns the most recent window.
   */
  async getMyReceiptsPage(options?: { before?: string; profile?: string; limit?: number }): Promise<ReceiptPage> {
    const params = new URLSearchParams();
    if (options?.before) params.set('before', options.before);
    if (options?.profile) params.set('profile', options.profile);
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    const res = await this.fetch(`/api/tickets/mine${qs ? '?' + qs : ''}`);
    if (!res.ok) throw new Error(`Failed to fetch receipts: ${res.status}`);
    const data = await res.json();
    return { receipts: data.tickets ?? [], nextBefore: data.nextBefore ?? null };
  }

  async listTeamReceiptsPage(groupId: string, options?: { before?: string; profile?: string; limit?: number }): Promise<ReceiptPage> {
    const params = new URLSearchParams();
    if (options?.before) params.set('before', options.before);
    if (options?.profile) params.set('profile', options.profile);
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    const res = await this.fetch(`/api/groups/${encodeURIComponent(groupId)}/tickets${qs ? '?' + qs : ''}`);
    if (!res.ok) throw new Error(`Failed to fetch team receipts: ${res.status}`);
    const data = await res.json();
    return { receipts: data.tickets ?? [], nextBefore: data.nextBefore ?? null };
  }

  // ─── Action Thread (homepage feed) ──────────────────────────────────────

  /**
   * Fetch a merged stream of proposals + receipts for the Action Thread.
   * The SP's `/api/tickets/mine` endpoint is date-keyed (one day at a
   * time), so multi-day history is assembled by looping over recent dates.
   */
  async getThread(options: {
    domain: string;
    sinceDays?: number;
    status?: 'pending' | 'all';
    profile?: string;
    includeAutonomous?: boolean;
    limit?: number;
  }): Promise<{ proposals: Proposal[]; receipts: ExecutionReceipt[] }> {
    const sinceDays = options.sinceDays ?? 7;
    const status = options.status ?? 'pending';

    // The active workspace plus the personal one (no active domain = personal only).
    const proposals = await this.getMyProposals(options.domain, status);

    let receipts: ExecutionReceipt[] = [];
    if (status === 'all') {
      const dates: string[] = [];
      const today = new Date();
      for (let i = 0; i < sinceDays; i++) {
        const d = new Date(today);
        d.setUTCDate(today.getUTCDate() - i);
        dates.push(d.toISOString().slice(0, 10));
      }
      const perDay = await Promise.all(
        dates.map((date) => this.getMyReceipts({ date, profile: options.profile })),
      );
      receipts = perDay.flat();
    }

    return { proposals, receipts };
  }

  // ─── Autostart ("Keep Suveren running") ─────────────────────────────────
  //
  // Goes through this client, not raw fetch: the control-plane authenticates
  // with an X-API-Key header, so a bare fetch — even with credentials:
  // 'include' — is rejected with 401.

  async getAutostart(): Promise<{
    supported: boolean;
    installed: boolean;
    platform: string;
    reason?: string;
    detail?: string;
  }> {
    const res = await this.fetch('/autostart');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async setAutostart(enabled: boolean): Promise<void> {
    const res = await this.fetch('/autostart', { method: enabled ? 'POST' : 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { message?: string }).message || `HTTP ${res.status}`);
    }
  }

  // ─── Authority Server pairing (as-url + pinned key fingerprint) ─────────

  async getAsPairing(): Promise<{
    asUrl: string;
    paired: boolean;
    fingerprint: string | null;
    pairedAt: string | null;
    /** Opt-in TLS pinning (`config set pin-tls on`) — see as-tls-pin.ts. */
    pinTlsEnabled: boolean;
    tlsPinFingerprint: string | null;
    // IT policy (see lib/policy.ts) — omitted by an older control-plane;
    // the UI must treat a missing field exactly like "not locked".
    asUrlLockedByPolicy?: boolean;
    pinTlsLockedByPolicy?: boolean;
  }> {
    const res = await this.fetch('/as-pairing');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ─── Skipped commitments (approved, but not submitted by this gateway) ──

  async getSkippedCommitments(): Promise<{ skipped: Array<{ id: string; tool: string; note: string }> }> {
    const res = await this.fetch('/skipped-commitments');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /**
   * "Awaiting others" stand-in (2026-10-15, real-gateway e2e): above-cap
   * proposals THIS gateway submitted that are still pending — the
   * Authority Server has no endpoint yet to list "proposals I created"
   * (only `?domain=`, which an above-cap proposal's empty pendingDomains
   * can never match, `?status=committed/rejected`, and `?approver=me`).
   * Round-trips through the gateway's own local submission record
   * (control-plane → MCP server's `/internal/my-pending-proposals`) — see
   * that route's doc comment for the real limitation this has until the
   * AS gets a creator-scoped query: only ever sees proposals submitted
   * through THIS gateway install. Fails soft (empty list) so a gateway
   * that predates this endpoint (404) never breaks the page.
   */
  async getMyPendingProposals(): Promise<Proposal[]> {
    const res = await this.fetch('/my-pending-proposals');
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({ proposals: [] }));
    return (data.proposals ?? []) as Proposal[];
  }

  // ─── Gate Content ───────────────────────────────────────────────────────

  async getGateContent(path: string): Promise<GateContentEntry | null> {
    const res = await this.fetch(`/gate-content?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(`Failed to fetch gate content: ${res.status}`);
    const data = await res.json();
    return data.entry ?? null;
  }

  /**
   * Re-sync every stored grant with the AS so revoked/deleted authorizations
   * drop out of the MCP cache immediately (list-authorizations reflects
   * reality). Enforcement never depends on this — a revoked grant is refused
   * at the receipt gate regardless — so callers treat it as best-effort.
   */
  async resyncGates(): Promise<void> {
    const res = await this.fetch('/resync-gates', { method: 'POST' });
    if (!res.ok) throw new Error(`Failed to resync gates: ${res.status}`);
  }

  /**
   * Enriched ACTIVE authorizations (the same set list-authorizations shows —
   * cache-backed, no stale entries), each with its local context (scope). Used
   * to compare a new grant's scope against existing grants at creation time.
   * Context stays local (privacy-blind) — this never touches the AS.
   */
  async getEnrichedAuthorizations(): Promise<EnrichedAuthorizationEntry[]> {
    const res = await this.fetch('/active-authorizations');
    if (!res.ok) throw new Error(`Failed to fetch authorizations: ${res.status}`);
    const data = await res.json();
    return data.authorizations ?? [];
  }

  async pushGateContent(data: {
    authorizationId?: string;
    boundsHash?: string;
    contextHash?: string;   // v0.4
    context?: Record<string, string | number>;  // v0.4
    /** Discovered display names per context field (value → label). */
    contextLabels?: Record<string, Record<string, string>>;
    path?: string;
    gateContent: Record<string, string>;
  }): Promise<void> {
    const res = await this.fetch('/gate-content', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to push gate content' }));
      throw new Error(asErrorMessage(err, `Push gate content failed: ${res.status}`));
    }
  }

  // ─── Agent Brief (context.md + session-brief preview) ─────────────────

  async getAgentContext(): Promise<string> {
    const res = await this.fetch('/agent-brief/context');
    if (!res.ok) throw new Error(`Failed to fetch agent context: ${res.status}`);
    const data = await res.json() as { content: string };
    return data.content;
  }

  async saveAgentContext(content: string): Promise<void> {
    const res = await this.fetch('/agent-brief/context', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to save agent context' }));
      throw new Error(asErrorMessage(err, `Save failed: ${res.status}`));
    }
  }

  // ─── AI chat (multi-turn refinement of context.md or intent) ──────────

  async aiChat(request: {
    target: { kind: 'context' } | { kind: 'intent'; profileId?: string; path?: string; bounds?: string };
    currentText: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  }): Promise<{ success: boolean; reply?: string; error?: string }> {
    const res = await this.fetch('/ai/chat', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'AI chat failed' }));
      return { success: false, error: asErrorMessage(err, `Chat failed: ${res.status}`) };
    }
    return res.json() as Promise<{ success: boolean; reply?: string; error?: string }>;
  }

  /** Read the current AI assistant system prompts (intent + context),
   *  including immutable defaults so the UI can compare. */
  async getAIPrompts(): Promise<Record<'intent' | 'context', { current: string; default: string; overridden: boolean }>> {
    const res = await this.fetch('/ai-prompts');
    if (!res.ok) throw new Error(`Failed to load AI prompts: ${res.status}`);
    return res.json() as Promise<Record<'intent' | 'context', { current: string; default: string; overridden: boolean }>>;
  }

  /** Save (or revert with empty value) an override for one prompt kind. */
  async setAIPrompt(kind: 'intent' | 'context', value: string): Promise<void> {
    const res = await this.fetch(`/ai-prompts/${kind}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Save failed' }));
      throw new Error(asErrorMessage(err, `Save failed: ${res.status}`));
    }
  }
}

export const spClient = new SPClient();
