/** Wire types the approval card renders. Moved verbatim from the gateway UI's sp-client.ts. */

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

/** A read's outcome where "nothing to read" (no_target) is itself a valid,
 *  non-error outcome. */
export type PreviewReadOutcome =
  | { status: 'ok'; body: PreviewBody }
  | { status: 'unavailable'; reason: 'no_connector' | 'connector_error' | 'timeout'; message?: string }
  | { status: 'not_found'; message?: string }
  /** The connector refused the read ("Refused: …") — its own words. */
  | { status: 'refused'; message?: string }
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
  /** Arg -> path of its CURRENT value in an attached read: those args show as one Now / New table (creation-extras.ts). */
  compare?: Record<string, string>;
  /** The card heading's verb: "What will be created" (default) or "changed". */
  verb?: 'created' | 'changed';
  /** Attach key -> dotted path of the record's NAME in that read (when it isn't a top-level `name`). */
  names?: Record<string, string>;
}

/** A manifest-declared check, evaluated by the gateway (mcp-server checks.ts). */
export type CheckStatus = 'pass' | 'fail' | 'notice' | 'not_checked';

export interface CheckResult {
  key: string;
  label: string;
  status: CheckStatus;
  index?: number;
  detail?: string;
  reason?: string;
  blocking?: true;
  value?: string | number | boolean | null;
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
  /** See mcp-server's tool-gating-types.ts `PreviewReadConfig.kind` — marks
   *  this read's result as a document to render (UI spec §15.1), not data
   *  to merge into field rows. */
  kind?: 'document';
  /** Display-only read (excluded from the changed-since-approval check): its own "From <label> — checked <time>" box. */
  displayOnly?: boolean;
  /** Input for checks only — never a card section. */
  as?: string;
  /** The source a display-only read names ("EU VIES"). */
  label?: string;
  /** The read is the record the action changes (manifest declares `version` on it). */
  target?: true;
  /** With `target`: the action argument that carries the record's version (the manifest's `version.arg`). */
  versionArg?: string;
}

/** `GET /proposal-status/:id/preview` — always 200 unless auth/proposal fetch fails. */
export type PreviewResponse = (
  | { status: 'none'; reason?: 'no_target' }
  | { status: 'unavailable'; reason: 'no_connector' | 'connector_error' | 'timeout'; message?: string }
  | { status: 'not_found'; message?: string }
  | { status: 'refused'; message?: string }
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
      /** The read is the very record the action changes (the manifest declares
       *  a `version` for it): the card shows the bound arguments as changes to
       *  it, old → new. Absent: the read is context only. */
      target?: true;
      /** With `target`: the action argument that carries the record's version (the manifest's `version.arg`). */
      versionArg?: string;
      /** The read is the gateway's own description of the proposal (a
       *  builtin's describe_* read: what the person signs), not a record read
       *  from a connected system. */
      describesProposal?: true;
    }
  /** AU8 — several reads (manifest `preview` is a list). Distinguished from
   *  the single-read "ok" above by `reads` (never both on the same object). */
  | { status: 'ok'; integration: string; readAt: number; reads: PreviewReadSection[]; display?: ToolDisplayHints }
) & {
  /** The tool's manifest checks, evaluated by the gateway over its own reads. */
  checks?: CheckResult[];
};

/** `GET /proposal-status/:id/outcome` — the local execution journal's latest entry. */
export interface OutcomeResponse {
  state: 'none' | 'intent' | 'done' | 'failed';
  outcome?: 'refused' | 'changed';
  detail?: string;
  at?: number;
}

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

export interface ModeOptionDecl { label?: string; explanation?: string; fields?: string[] }

/** A shared sign-in: one account, several connectors (from the manifests' `oauth.signInGroup`). */
export interface SignInGroup {
  id: string;
  name: string;
  /** Connector ids, in manifest order. */
  members: string[];
  /** Union of the members' scopes - what the one sign-in requests. */
  scopes: string[];
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
    revokeUrl?: string;
    scopes: string[];
    credentialKeys: Record<string, string>;
    tokenStorage: string;
    extraParams?: Record<string, string>;
    /** Connectors with the same group id share ONE sign-in (declared in the manifest). */
    signInGroup?: { id: string; name: string };
    /** The sign-in applies only while this data-source option is chosen. */
    forOption?: { mode: string; adapter?: string };
  } | null;
  /** Per-tool gating. Typed only where the UI reads it — `actionLabel` names
   *  what a tool DOES, in words, for the receipts list; `profile` is area
   *  per tool (a connector may span several areas; an override may name its
   *  OWN profile instead of the manifest's — see integration-grouping.ts's
   *  `connectorAreas`). */
  toolGating?: {
    overrides?: Record<string, { profile?: string; actionLabel?: string; summary?: string; display?: { currencyField?: string } } | null>;
  } | null;
  /** Words for a shared limit's sentences, keyed by the bound's key (validated by the manifest loader). */
  limitWords?: Record<string, { noun: string; pastParticiple: string }> | null;
  /** Declares a simulation mode: the credential field holding it and its default. Drives the "Simulation" badge. */
  simulation?: { field: string; default: string } | null;
  /** Touches only this computer (e.g. Files): runs in simulation mode too, so it is never paused by it. */
  localOnly?: boolean;
  /** Display labels for this connector's CURRENT mode — "<name> · <label>" on
   *  the Integrations card (e.g. "ERP · Built-in", "ERP · Test data"). Keyed
   *  by the `simulation.field` value; an object entry is keyed by the
   *  `adapterField` setting's value. See manifest-loader.ts's doc comment. */
  modeLabels?: Record<string, string | Record<string, string>> | null;
  modeNotes?: IntegrationManifest['modeLabels'];
  /** The mode CHOICE on the card: same keys as `modeLabels`; a string-labelled mode maps to one option object,
   *  an adapter-keyed mode maps adapter → option object. `fields` = credential keys needed only by that option.
   *  See manifest-loader.ts's `modeOptions` doc comment. */
  modeOptions?: Record<string, ModeOptionDecl | Record<string, ModeOptionDecl>> | null;
  /** Credential field holding which adapter backs a non-simulated mode (e.g. erp.json's `liveAdapter`). */
  adapterField?: string;
  /** Links the approval card offers so a reviewer can inspect the action. */
  proposalLinks?: Array<{ label: string; template: string; description?: string }>;
  templates?: AuthTemplate[];
  setupHint?: string;
  setupGuide?: Array<{ title: string; description: string; link?: string; simulationOnly?: boolean }>;
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
  /** UI spec §15.2 — document kinds this connector can hand the gateway
   *  (mcp-server tool-gating-types.ts `ManifestDocuments`); only the display
   *  label template is typed here — the read tool/args stay server-side. */
  documents?: Record<string, { label?: string }>;
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
  /** Seconds since the epoch: when this mandate ends. */
  expiresAt?: number | null;
  title?: string | null;
  /** v0.7 item 9 — the AS no longer verifies this mandate's protocol
   *  version (a VERSION_UNSUPPORTED ticket refusal). Learned lazily by the
   *  gateway, only once an execution was actually attempted under it. */
  needsReapproval?: boolean;
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
  /** Set by the Authority Server on a waiting proposal whose mandate is revoked or expired: it can never be approved. */
  mandateEnded?: 'revoked' | 'expired';
  executionResult: unknown | null;
  createdAt: number;
  expiresAt: number;
  /** Set iff status === 'refused' — the AS's own code/message for why. */
  refusal?: {
    code: string;
    message: string;
    at: number;
    /** The bound the refusal is about, and the numbers — present only on an Authority Server that records them. */
    field?: string;
    expected?: unknown;
    actual?: unknown;
  };
  // Phase 6 fields
  pendingApprovers?: string[];
  approvedBy?: Record<string, { receiptId: string; at: number }>;
  approverRejectedBy?: { userId: string; reason?: string; at: number; outcome?: ProposalOutcome; note?: string; noteEncrypted?: NoteEncryptedWire };
  createdBy?: string;
  /**
   * suveren-as#89 — set only by `POST /api/proposals/:id/withdraw` (the
   * proposal's own creator declining to pursue it — status flips to
   * 'rejected', same as every other terminal decision here, but this field
   * is what tells "the proposer backed out" apart from someone else's
   * reject/change_needed/replaced). Never set by any other route.
   */
  withdrawnBy?: { userId: string; at: number; note?: string; noteEncrypted?: NoteEncryptedWire };
}

/** One cumulative bound as it stands now, for one action type (Authority Server `cumulative_usage`). */
export interface CumulativeUsageEntry {
  field: string;
  action_type: string;
  kind: 'cumulative_count' | 'cumulative_sum';
  window: 'daily' | 'weekly' | 'monthly';
  of?: string;
  /** Consumed in the window, team-wide. */
  used: number;
  /** The stricter of the mandate's bound and the group ceiling; null if neither is set. */
  limit: number | null;
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

/** A window of receipts plus a cursor for loading the next (older) window. */
export interface ReceiptPage {
  receipts: ExecutionReceipt[];
  /** Pass back as `before` to load older receipts; null when none remain. */
  nextBefore: string | null;
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
