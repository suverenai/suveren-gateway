/**
 * SP API Client for Platform UI
 *
 * All requests go through the control-plane, which proxies /api/* to the SP.
 * Authentication is API-key-based (X-API-Key header on every request).
 * No cookies are used — the API key is stored in React state only.
 */

import { readRefusal } from '@hap/core/refusal';
import { isRetriableRead, unreachableRetry } from './unreachable-retry';
import { T, textForCode, isDecisionCode } from './device-texts';
import { queueDomains, mergeProposals } from './my-queue';
import type { MemberJoinApi, AdminJoinApi, JoinResult, TeamChangesApi, TeamChangesView } from '@suveren/approval-card/mandate-screens';
import type { AttachmentPreviewResult } from '@suveren/approval-card/lib/attachment-sealed';
import type { ProfileSummary, PreviewBody, PreviewVersionInfo, PreviewReadOutcome, ToolDisplayHints, CheckStatus, CheckResult, PreviewReadSection, PreviewResponse, OutcomeResponse, RequestChainItem, RequestResult, HistoryItem, ConnectorHistoryMatch, HistoryResult, RequestContextResponse, ShownSnapshotPayload, ShownHashEntry, ShownHashes, AuthTemplate, ModeOptionDecl, SignInGroup, IntegrationManifest, GateContentEntry, EnrichedAuthorizationEntry, ProposalOutcome, ProposalContentWire, NoteEncryptedWire, Proposal, CumulativeUsageEntry, ExecutionReceipt, ReceiptPage, CapKind, ProfileConfig } from '@suveren/approval-card/types';

// The wire types the approval card renders live in the shared package; re-exported so every other caller is unchanged.
export type { ProfileSummary, PreviewBody, PreviewVersionInfo, PreviewReadOutcome, ToolDisplayHints, CheckStatus, CheckResult, PreviewReadSection, PreviewResponse, OutcomeResponse, RequestChainItem, RequestResult, HistoryItem, ConnectorHistoryMatch, HistoryResult, RequestContextResponse, ShownSnapshotPayload, ShownHashEntry, ShownHashes, AuthTemplate, ModeOptionDecl, SignInGroup, IntegrationManifest, GateContentEntry, EnrichedAuthorizationEntry, ProposalOutcome, ProposalContentWire, NoteEncryptedWire, Proposal, CumulativeUsageEntry, ExecutionReceipt, ReceiptPage, CapKind, ProfileConfig } from '@suveren/approval-card/types';

/**
 * The HAP protocol versions this gateway verifies and enforces, newest first —
 * what every mandate request sends as `supported_versions` so the Authority
 * Server issues the highest version both sides support (protocol.md →
 * Version negotiation, rule 1). Mirrors hap-core's `SUPPORTED_VERSIONS`; the UI
 * bundle cannot import hap-core at runtime, so the two are kept equal by
 * `supported-versions.test.ts`.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['0.8', '0.7'];

/** Ticket headline values from this gateway's own archive, keyed by ticket id (UI spec §13.4). */
export interface TicketHeadlineMaps {
  /** Automatic tickets: what this gateway sent. */
  automatic: Record<string, Record<string, unknown>>;
  /** Review-path tickets: the approved toolArgs archived when this gateway executed them. */
  approved: Record<string, Record<string, unknown>>;
}

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
  /** The creator, who is the team's admin on the Authority Server (groups-store `createdBy`). */
  createdBy?: string;
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


/**
 * Earliest expiry of a mandate row. The AS sends the per-domain entries as
 * `mandates` since v0.7 (`/api/mandates/mine`); older AS builds sent
 * `attestations`. Reading only the old name left every mandate without an
 * expiry: no "Valid" row, no "expiring soon", expired ones counted active.
 */
export function expiryOf(entries: unknown): { earliest_expiry: string | null; remaining_seconds: number | null } {
  const list = Array.isArray(entries) ? (entries as Array<{ expiresAt?: unknown }>).map(e => e?.expiresAt).filter((x): x is number => typeof x === 'number') : [];
  if (list.length === 0) return { earliest_expiry: null, remaining_seconds: null };
  const min = Math.min(...list);
  return { earliest_expiry: new Date(min * 1000).toISOString(), remaining_seconds: Math.max(0, min - Math.floor(Date.now() / 1000)) };
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
export type DenialKind = 'read' | 'bound' | 'scope' | 'cumulative' | 'simulation' | 'not_authorized' | 'check' | 'unsealed_arg';
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



// ─── AU8: several reads per preview ────────────────────────────────────────
// Interface contract: temp/briefs/au8-brief.md. Mirrors
// apps/control-plane/src/lib/preview-types.ts and apps/mcp-server/src/lib/
// preview.ts's `PreviewReadSection`/`ToolDisplayHints` — do not change these
// shapes without the brief's owner.







// ─── AU10 — Request + History (doc/au10-request-context.md) ───────────────







// ─── AU10 §8.4 — "What you saw" snapshot ───────────────────────────────────


/** `GET /proposal-status/:id/shown-snapshot` — the ticket view's "What you saw". */
export type ShownSnapshotResponse =
  | { status: 'off_device' }
  | { status: 'ok'; snapshot: ShownSnapshotPayload; shownHash: string; storedAt: number; verifiedLocally: boolean };







export interface McpIntegrationStatus {
  id: string;
  name: string;
  running: boolean;
  toolCount: number;
  /** A REAL problem (crash, failed spawn, etc). Never set for the simulation
   *  block — see `paused`, which is structural, not an error. */
  error?: string;
  /**
   * The connector's OWN words for why it cannot do its work (never the
   * gateway's, never the AI's): its status check's answer while running, or
   * its last error output when it stopped while starting. Shown as
   * "<connector> says", apart from `error`. Also set on a RUNNING connector —
   * running is not the same as working.
   */
  problem?: string;
  /**
   * Set instead of `error` when this connector is not running SOLELY because
   * simulation mode is on and its manifest declares no `simulation` marker.
   * Paused-by-design, not broken — drives the neutral "Paused" chip and keeps
   * it out of "Needs your attention" (see IntegrationStatusContext).
   */
  paused?: 'simulation' | 'production';
  /**
   * Local read-age window in days, or null when unset (reads then fall back to
   * the signed grant bound). `0` means "read nothing" and is NOT the same as
   * null — never collapse them with a truthiness check.
   */
  readAgeDays?: number | null;
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
    /** Automatic path (UI spec §14) — exactly the args this gateway executed. */
    sentArgs?: Record<string, unknown>;
    /** Set instead of `sentArgs` when they were too large to keep. */
    sentArgsOmitted?: 'too_large';
  };
  authorization: LocalAuthorization | null;
  signature: SignatureStatus;
  /**
   * The archived args (sentArgs, or an approved ticket's proposal.toolArgs)
   * checked by the gateway against the hash in its own execution journal —
   * "matches what this gateway executed". Absent from an older control plane.
   */
  sentArgsCheck?: SentArgsCheck;
  /** What the tool answered (§14.2), kept on this device; null when not kept. */
  result?: TicketResult | null;
}

export type SentArgsCheck = 'match' | 'mismatch' | 'unchecked';

export interface TicketResult {
  ok: boolean;
  text: string;
  structuredContent?: Record<string, unknown>;
  truncated?: boolean;
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
  /** The reporting window the evidence was scoped to, as the gateway used it
   *  (unix seconds; tickets up to end + 2 min are inside). Absent on reports
   *  stored before it was recorded. */
  window?: { start: number; end: number; days: number; label: string };
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
/** Fired on {@link sessionEvents} when the control plane answers 401 to a signed-in request. */
export const SESSION_GONE_EVENT = 'suveren:session-gone';
/** Where the client announces a lost session; the auth context listens. */
export const sessionEvents = new EventTarget();

/** What a 401 of a password gateway says about the page session (control plane: lib/page-session.ts). */
export const SESSION_CODES: ReadonlySet<string> = new Set(['session_missing', 'session_invalid', 'session_idle', 'session_expired', 'locked']);

/** Detail of {@link SESSION_GONE_EVENT} on a gateway with a page session: why the session ended. */
export interface SessionGoneDetail { code: string }

/** Asked when a change to a stored connector login needs the person's confirmation; resolves the confirmed request id, or null when the person cancelled. */
export type ChangeConfirmer = (ask: { kind: 'replace' | 'remove'; name: string; change: unknown }) => Promise<string | null>;

/** The person cancelled a confirmation: nothing was sent. */
export class ConfirmationCancelled extends Error {
  constructor() { super('confirmation_cancelled'); this.name = 'ConfirmationCancelled'; }
}

/** Requests whose 401 means "wrong credentials", not "session gone". */
export function isAuthPath(path: string): boolean {
  return /^\/(api\/)?auth\//.test(path);
}

export class DifferentAccountError extends Error {
  readonly summary: DifferentAccountSummary;
  constructor(summary: DifferentAccountSummary) {
    super('different_account');
    this.name = 'DifferentAccountError';
    this.summary = summary;
  }
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
/** What a give would grant, as the gateway checked it (POST /api/mandate/prepare); the page shows this and echoes `planHash` with the give. */
export interface PreparedMandate {
  planHash: string; profileId: string; profileName: string; profileHash: string;
  mode: 'automatic' | 'review' | 'review_above_cap'; ttlSeconds: number; expiresAt: number;
  bounds: Array<{ field: string; label: string; value: string | number; unit?: string }>;
  scope: Array<{ field: string; label: string; value: string | number; unit?: string }>;
  intent: string;
  team: { approvers: Array<{ userId: string; did: string; identityCode: string; isYou: boolean; confirmed: boolean }>; approvals: number | null; caps: Array<{ field: string; label: string; value: string | number; unit?: string }> } | null;
  blocked: { code: string; message: string; approvers?: Array<{ userId: string; did: string; identityCode: string }> } | null;
  /** Another active device of the person's chain can grant it (DEC-90): the page offers "Give on your phone" when this computer cannot. */
  onPhone?: boolean;
}

/** A refused `/api/mandate/sign`: the same message as before, plus the gateway's code (and, for unconfirmed approvers, who). */
/** The approver ids a grant refusal names (approver_has_no_chain); only strings, never anything else from the answer. */
function approverIdsOf(body: unknown): string[] | undefined {
  const v = (body as { approverIds?: unknown } | null)?.approverIds;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

export class MandateSignError extends Error {
  constructor(message: string, readonly code: string | undefined, readonly status: number, readonly approvers?: Array<{ userId: string; did: string; identityCode: string }>, readonly reason?: string, readonly approverIds?: string[]) { super(message); this.name = 'MandateSignError'; }
}

export function asErrorMessage(body: unknown, fallback: string): string {
  const r = readRefusal(body, fallback);
  return r.code && r.message !== r.code ? `${r.message} (${r.code})` : r.message;
}

export function parseApproverPubkeys(data: unknown): Array<{ userId: string; publicKey: string }> {
  const map = (data as { pubkeys?: unknown })?.pubkeys;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.entries(map as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0)
    .map(([userId, publicKey]) => ({ userId, publicKey }));
}

/** The gateway's own preferences (control plane `settings.json`) — the persisted truth, never browser storage. */
export interface GatewaySettings {
  desktopNotifications: boolean;
  /** An approval waiting for this person slides in by itself. Default on. */
  openApprovalsAutomatically: boolean;
}

/**
 * Does `/health` say this gateway has device keys? Only an explicit `deviceKeys: true` does; a gateway without
 * them does not send the member at all, so its decisions keep the legacy path.
 */
export function deviceDecisionsFromHealth(health: unknown): boolean {
  return (health as { deviceKeys?: unknown } | null | undefined)?.deviceKeys === true;
}

class SPClient {
  private apiKey: string | null = null;
  /**
   * The page session's header token (device-keys plan 7). Kept in memory only, sent as `X-Suveren-Session` on every
   * request. Null on a gateway without an unlock password: every request is then exactly what it was before.
   */
  private sessionToken: string | null = null;
  private confirmer: ChangeConfirmer | null = null;
  /**
   * Device keys (plan 6.3, step 12): on a gateway with a device chain a decision is signed with this
   * computer's key by the control plane (`/device-decision/:id/:route`), which then forwards it to the
   * Authority Server. Off (the default) every decision goes the legacy way, byte for byte as before.
   * Set by {@link detectDeviceDecisions} once the page has its session (the unlock screens, O19), never guessed.
   */
  private deviceDecisions = false;

  setDeviceDecisions(on: boolean): void {
    this.deviceDecisions = on;
  }

  /**
   * Ask the gateway whether it has a device chain. Only an explicit yes switches the path; 404 (switch
   * off), 401, 409 or anything unreadable keeps the legacy path, whose refusal by a chain account's
   * Authority Server (DEVICE_DECISION_REQUIRED) is then what the person sees: never a silent fallback to unsigned.
   */
  async detectDeviceDecisions(): Promise<boolean> {
    try {
      const res = await this.fetch('/device-decision/status');
      const body = res.ok ? await res.json().catch(() => null) : null;
      this.deviceDecisions = (body as { deviceKeys?: unknown } | null)?.deviceKeys === true;
    } catch {
      this.deviceDecisions = false;
    }
    return this.deviceDecisions;
  }

  /**
   * The words for a refused decision. On the device path the control plane's neutral code gets its text
   * (lib/device-texts.ts); anything else, and every gateway without device keys, reads as it always did.
   */
  private decisionError(body: unknown, fallback: string): string {
    const code = (body as { code?: unknown } | null)?.code;
    if (this.deviceDecisions) {
      // On the device path only the gateway's own codes have words; anything else (a refusal of the Authority Server
      // passed through, an unknown code) reads as the generic text, never as the server's message.
      return typeof code === 'string' && isDecisionCode(code) ? textForCode(code, { screen: 'general' }) : T.generic;
    }
    return asErrorMessage(body, fallback);
  }

  /** Where a decision on `id` goes: the same four route names, locally signed on a gateway with a device chain. */
  private decisionPath(id: string, route: 'approve' | 'reject' | 'resolve' | 'withdraw'): string {
    return `${this.deviceDecisions ? '/device-decision' : '/api/proposals'}/${encodeURIComponent(id)}/${route}`;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  setSessionToken(token: string | null): void {
    this.sessionToken = token;
    if (!token) unreachableRetry.cancelAll();
  }

  hasPageSession(): boolean {
    return this.sessionToken !== null;
  }

  /** The screen that asks the person to confirm a change to a stored login (screen 5). */
  setConfirmer(fn: ChangeConfirmer | null): void {
    this.confirmer = fn;
  }

  /** Any call of the control plane with the page's credentials (device screens use this; nothing is retried). */
  async request(path: string, init?: RequestInit): Promise<Response> {
    return this.fetch(path, init ?? {});
  }

  /**
   * Is the page session still accepted? One cheap call; a 401 announces why (SESSION_GONE_EVENT). Used when the event
   * stream ended, which is how a session's end shows.
   */
  async sessionStillOpen(): Promise<boolean> {
    try {
      const res = await this.fetch('/auth/device/status', {});
      // 404: no device routes (the unlock password alone): the stream ended for another reason.
      return res.status !== 401;
    } catch { return true; }
  }

  /** The event stream, read with fetch because EventSource cannot send the session header. */
  async openEventStream(signal: AbortSignal): Promise<Response> {
    return this.fetch('/events', { signal, headers: { Accept: 'text/event-stream' } });
  }

  /**
   * Send a change to a stored login. When the gateway asks for the person's confirmation of exactly this change
   * (403 `confirmation_required`), the confirmer is asked and the same call is sent again with the confirmed request.
   * `change` is what the control plane hashes for this route (routes/vault.ts, routes/oauth-flow.ts).
   */
  private async sendConfirmed(path: string, init: RequestInit, change: unknown): Promise<Response> {
    const res = await this.fetch(path, init);
    if (res.status !== 403 || !this.sessionToken) return res;
    const body = await res.clone().json().catch(() => null) as { code?: string; kind?: string; name?: string } | null;
    if (body?.code !== 'confirmation_required' || (body.kind !== 'replace' && body.kind !== 'remove') || !body.name) return res;
    if (!this.confirmer) return res;
    const id = await this.confirmer({ kind: body.kind, name: body.name, change });
    if (!id) throw new ConfirmationCancelled();
    return this.fetch(path, { ...init, headers: { ...init.headers, 'X-Suveren-Confirmation': id } });
  }

  /**
   * Where the page opens an OAuth sign-in. Without a page session: the plain start address, as before. With one: a
   * one-time start ticket (the new window cannot send the header); over a stored sign-in it needs the person's
   * confirmation of that exact change first.
   */
  async oauthStartUrl(integrationId: string): Promise<string> {
    const plain = `/auth/oauth/${encodeURIComponent(integrationId)}/start`;
    if (!this.sessionToken) return plain;
    const res = await this.sendOAuthChange(integrationId, `/auth/oauth/${encodeURIComponent(integrationId)}/start-ticket`, 'sign-in');
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error((err as { code?: string } | null)?.code ?? `start-ticket ${res.status}`);
    }
    const body = await res.json() as { url?: string };
    if (!body.url) throw new Error('start_ticket_invalid');
    return body.url;
  }

  /** Sign out of an OAuth connector (a removal of a login: confirmed on a password gateway). */
  async oauthDisconnect(integrationId: string): Promise<Response> {
    return this.sendOAuthChange(integrationId, `/auth/oauth/${encodeURIComponent(integrationId)}/disconnect`, 'disconnect');
  }

  private async sendOAuthChange(integrationId: string, path: string, op: 'sign-in' | 'disconnect'): Promise<Response> {
    const init: RequestInit = { method: 'POST' };
    const res = await this.fetch(path, init);
    if (res.status !== 403 || !this.sessionToken || !this.confirmer) return res;
    const body = await res.clone().json().catch(() => null) as { code?: string; kind?: string; name?: string } | null;
    if (body?.code !== 'confirmation_required' || (body.kind !== 'replace' && body.kind !== 'remove') || !body.name) return res;
    // The exact change the control plane will hash: it names it itself.
    const ch = await this.fetch(`/auth/oauth/${encodeURIComponent(integrationId)}/change?op=${op}`);
    const change = ch.ok ? ((await ch.json().catch(() => null)) as { change?: unknown } | null)?.change ?? null : null;
    const id = await this.confirmer({ kind: body.kind, name: body.name, change });
    if (!id) throw new ConfirmationCancelled();
    return this.fetch(path, { ...init, headers: { 'X-Suveren-Confirmation': id } });
  }

  clearApiKey(): void {
    this.apiKey = null;
    unreachableRetry.cancelAll();
  }

  /**
   * Used by EventSource (which can't send custom headers) to authenticate the
   * /events stream via a query-string token. Returns null if not logged in.
   */
  getApiKey(): string | null {
    return this.apiKey;
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const send = (signal?: AbortSignal) => globalThis.fetch(path, {
      ...init,
      ...(signal ? { signal } : {}),
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
        ...(this.sessionToken ? { 'X-Suveren-Session': this.sessionToken } : {}),
        ...init?.headers,
      },
    });
    // A call without init is a plain read: safe to try again (see unreachable-retry.ts). Writes are never repeated.
    const res = init === undefined && isRetriableRead(path) ? await unreachableRetry.read(path, send) : await send();
    // A signed-in tab whose session the gateway no longer accepts — typically
    // after a restart, which locks the vault and sends no 'session-locked'
    // event. Without this every page shows its own wrong error (Integrations
    // said "MCP server is not reachable"). Sign-in calls are excluded: a
    // wrong key there is the login form's own error, not a lost session.
    if (this.sessionToken) {
      // A page session: the 401 says why it ended (idle, 12 hours, locked, closed). Sign-in calls count too, but only
      // for the session codes: a wrong password is the unlock screen's own error.
      if (res.status === 401) {
        const body = await res.clone().json().catch(() => null) as { code?: string; reason?: string } | null;
        const code = body?.reason ?? body?.code ?? 'session_missing';
        if (SESSION_CODES.has(code)) {
          sessionEvents.dispatchEvent(new CustomEvent<SessionGoneDetail>(SESSION_GONE_EVENT, { detail: { code } }));
        }
      }
    } else if (res.status === 401 && this.apiKey && !isAuthPath(path)) {
      sessionEvents.dispatchEvent(new Event(SESSION_GONE_EVENT));
    }
    return res;
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
    if (!res.ok) {
      // Read the body ONCE: a 409 is either the wipe question or a refusal whose
      // `message` the person must see as written (e.g. "This gateway is signed in
      // to another account. …"). A second read fails and showed "Invalid API key".
      const err = await res.json().catch(() => ({ error: 'Invalid API key' }));
      if (res.status === 409 && err?.wouldWipe) {
        throw new DifferentAccountError(err.summary ?? { credentialCount: 0, serviceCount: 0, credentialIds: [] });
      }
      throw new Error(asErrorMessage(err, `Login failed: ${res.status}`));
    }
    const data = await res.json();
    return data.user;
  }

  /**
   * Who is signed in, on a gateway whose page signed in by device key (no account key was typed, so `login()`
   * never returned the person). The control plane has no route for it, so it is read from the person's own
   * Personal workspace, which has exactly one member: the person. Null when it cannot be read.
   */
  async loadSessionUser(): Promise<SPUser | null> {
    try {
      const groups = await this.getGroups();
      const personal = groups.find(g => g.isPersonal) ?? groups[0];
      if (!personal) return null;
      const detail = await this.getGroupById(personal.id);
      return sessionUserFromGroup(detail);
    } catch { return null; }
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
    /** Version negotiation (protocol.md -> Version negotiation); required.
     *  Send {@link SUPPORTED_PROTOCOL_VERSIONS}. A gateway/UI speaking only an
     *  older version gets VERSION_UNSUPPORTED, "grant this mandate again". */
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
      ...expiryOf(a.mandates ?? a.attestations),
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

  /**
   * The values automatic tickets' headlines are built from (UI spec §13.4),
   * keyed by ticket id — this device's archive only, trimmed for headlines.
   */
  /** The approved toolArgs of a proposal this gateway executed, from its archive; `null` = no local copy. */
  async getArchivedProposalArgs(proposalId: string): Promise<Record<string, unknown> | null> {
    const res = await this.fetch(`/api/evidence/proposal/${encodeURIComponent(proposalId)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Local evidence unavailable (${res.status})`);
    const data = await res.json();
    return (data?.toolArgs ?? null) as Record<string, unknown> | null;
  }

  async getTicketHeadlines(): Promise<TicketHeadlineMaps> {
    const res = await this.fetch('/api/evidence/headlines');
    if (!res.ok) throw new Error(`Local evidence unavailable (${res.status})`);
    const data = await res.json();
    return {
      automatic: (data?.headlines ?? {}) as Record<string, Record<string, unknown>>,
      approved: (data?.approved ?? {}) as Record<string, Record<string, unknown>>,
    };
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

  /**
   * End a mandate on a gateway with a device chain (step 13, screen 4): signed by an active device key, final, no Touch ID.
   * Answers a code the page maps to its text; never throws for a refusal. A gateway without a chain answers 409 not_set_up.
   */
  async endMandate(authorizationId: string): Promise<{ ok: true } | { ok: false; code: 'already_ended' | 'unknown' | 'offline' | 'other' }> {
    let res: Response;
    try {
      res = await this.fetch('/api/mandate/revoke', { method: 'POST', body: JSON.stringify({ authorizationId }) });
    } catch { return { ok: false, code: 'offline' }; }
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({})) as { code?: string; grantCode?: string };
    const code = body.grantCode ?? body.code;
    if (code === 'mandate_revoked') return { ok: false, code: 'already_ended' };
    if (code === 'mandate_unknown') return { ok: false, code: 'unknown' };
    if (code === 'as_unreachable' || res.status === 502 || res.status === 503) return { ok: false, code: 'offline' };
    return { ok: false, code: 'other' };
  }

  /**
   * The join screens' routes on this gateway's own control plane (DEC-73 step 4; a gateway with a device chain only).
   * Never throws: a refusal, an unreachable gateway or an answer of another shape is `{ ok: false, code }`. Backend truth only:
   * what the screen shows (the person's own code, the tries left, whether a code matched) is what the gateway answered.
   */
  private async joinCall<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<JoinResult<T>> {
    let res: Response;
    try {
      res = await this.fetch(`/api/team-join${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch { return { ok: false, code: 'as_unreachable' }; }
    const data = await res.json().catch(() => null) as ({ ok?: boolean; code?: string; triesLeft?: number } & Record<string, unknown>) | null;
    if (data && data.ok === true) return data as unknown as JoinResult<T>;
    return { ok: false, code: typeof data?.code === 'string' ? data.code : 'other', ...(typeof data?.triesLeft === 'number' ? { triesLeft: data.triesLeft } : {}) };
  }

  /** The member's column of the join (the person who asked to join). */
  readonly memberJoin: MemberJoinApi = {
    view: (teamId) => this.joinCall('GET', `/member/${encodeURIComponent(teamId)}`),
    check: (teamId, code) => this.joinCall('POST', `/member/${encodeURIComponent(teamId)}/check`, { code }),
    anchor: (teamId) => this.joinCall('POST', `/member/${encodeURIComponent(teamId)}/anchor`, {}),
  };

  /** The admin's column of the join. */
  readonly adminJoin: AdminJoinApi = {
    view: (teamId) => this.joinCall('GET', `/admin/${encodeURIComponent(teamId)}`),
    check: (teamId, userId, code) => this.joinCall('POST', `/admin/${encodeURIComponent(teamId)}/${encodeURIComponent(userId)}/check`, { code }),
    add: (teamId, userId) => this.joinCall('POST', `/admin/${encodeURIComponent(teamId)}/${encodeURIComponent(userId)}/add`, {}),
  };

  private async changesCall<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<JoinResult<T>> {
    let res: Response;
    try {
      res = await this.fetch(`/api/team-changes${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch { return { ok: false, code: 'as_unreachable' }; }
    const data = await res.json().catch(() => null) as ({ ok?: boolean; code?: string; triesLeft?: number } & Record<string, unknown>) | null;
    if (data && data.ok === true) return data as unknown as JoinResult<T>;
    return { ok: false, code: typeof data?.code === 'string' ? data.code : 'other', ...(typeof data?.triesLeft === 'number' ? { triesLeft: data.triesLeft } : {}) };
  }

  /** Changes of the team's member list after the join (DEC-73 step 5): remove, new identity, re-sign, hand-over. */
  readonly teamChanges: TeamChangesApi = {
    view: async (teamId) => {
      const r = await this.changesCall<Record<string, unknown>>('GET', `/${encodeURIComponent(teamId)}`);
      if (!r.ok) return r;
      const { ok: _ok, ...rest } = r as Record<string, unknown>;
      return { ok: true, changes: rest as unknown as TeamChangesView };
    },
    remove: (teamId, did) => this.changesCall('POST', `/${encodeURIComponent(teamId)}/remove`, { did }),
    replaceCheck: (teamId, userId, oldDid, code) => this.changesCall('POST', `/${encodeURIComponent(teamId)}/replace/${encodeURIComponent(userId)}/check`, { oldDid, code }),
    replace: (teamId, userId, oldDid) => this.changesCall('POST', `/${encodeURIComponent(teamId)}/replace/${encodeURIComponent(userId)}`, { oldDid }),
    resign: (teamId) => this.changesCall('POST', `/${encodeURIComponent(teamId)}/resign`, {}),
    handoverOffer: (teamId, did) => this.changesCall('POST', `/${encodeURIComponent(teamId)}/handover`, { did }),
    handoverBuild: (teamId) => this.changesCall('POST', `/${encodeURIComponent(teamId)}/handover/build`, {}),
    handoverSign: (teamId) => this.changesCall('POST', `/${encodeURIComponent(teamId)}/handover/sign`, {}),
    handoverWithdraw: (teamId) => this.changesCall('DELETE', `/${encodeURIComponent(teamId)}/handover`),
  };

  /** Mandates this gateway holds back, with its own verdict code (step 13, screen 3). `null` when it cannot say (no chain, offline). Read-only. */
  async getHeldBack(): Promise<Array<{ authorizationId: string; mandateId: string; code: string; profileName: string; ownerIsYou: boolean; ownerName: string | null; adminName: string | null }> | null> {
    try {
      const res = await this.fetch('/api/mandate/held-back');
      if (!res.ok) return null;
      const body = await res.json() as { held?: unknown };
      return Array.isArray(body.held) ? body.held as never : null;
    } catch { return null; }
  }

  /** The prepared change for a mandate: the gateway's diff and the team's terms before (signed) and after (settings now). Signs nothing. */
  async previewMandateChange(authorizationId: string, changes: Record<string, unknown>): Promise<
    | { ok: true; profileName: string; diff: import('@hap/core/mandate-change').MandateDiff; before: import('@suveren/approval-card/mandate-screens').TeamTerms | null; after: import('@suveren/approval-card/mandate-screens').TeamTerms | null }
    | { ok: false; code: 'no_change' | 'not_your_mandate' | 'mandate_not_active' | 'other' }
  > {
    try {
      const res = await this.fetch(`/api/mandate/change-preview?authorizationId=${encodeURIComponent(authorizationId)}&changes=${encodeURIComponent(JSON.stringify(changes))}`);
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (res.ok) return { ok: true as const, ...(body as { profileName: string; diff: never; before: null; after: null }) };
      const code = body.code as string | undefined;
      return { ok: false, code: code === 'no_change' || code === 'not_your_mandate' || code === 'mandate_not_active' ? code : 'other' };
    } catch { return { ok: false, code: 'other' }; }
  }

  /** Sign the change with this computer's check (Touch ID). `sealedDiff` is the diff that was shown: a different change is refused. */
  async changeMandate(authorizationId: string, changes: Record<string, unknown>, sealedDiff: unknown, fromProposal?: string): Promise<{ ok: true } | { ok: false; code: 'changed_since_proposal' | 'no_change' | 'not_your_mandate' | 'mandate_not_active' | 'cancelled' | 'no_check_key' | 'other' }> {
    let res: Response;
    try { res = await this.fetch('/api/mandate/change', { method: 'POST', body: JSON.stringify({ authorizationId, changes, sealedDiff, ...(fromProposal ? { fromProposal } : {}) }) }); } catch { return { ok: false, code: 'other' }; }
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({})) as { code?: string; grantCode?: string };
    if (body.grantCode === 'check_failed') return { ok: false, code: 'cancelled' };
    if (body.grantCode === 'no_check_key') return { ok: false, code: 'no_check_key' };
    const c = body.code;
    return { ok: false, code: c === 'changed_since_proposal' || c === 'no_change' || c === 'not_your_mandate' || c === 'mandate_not_active' ? c : 'other' };
  }

  /** The same change sent to the phone (DEC-90): this computer has no Touch ID. Then wait with `pollGiveOnPhone`. A refusal throws. */
  async changeOnPhone(authorizationId: string, changes: Record<string, unknown>, sealedDiff: unknown, fromProposal?: string): Promise<{ mandateId: string; mandateVersion: number; expiresAt: number }> {
    const res = await this.fetch('/api/mandate/change-on-phone', { method: 'POST', body: JSON.stringify({ authorizationId, changes, sealedDiff, ...(fromProposal ? { fromProposal } : {}) }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const b = body as { code?: string; grantCode?: string; reason?: string };
      throw new MandateSignError(asErrorMessage(body, `Sending to your phone failed: ${res.status}`), b.grantCode ?? b.code, res.status, undefined, b.reason, approverIdsOf(body));
    }
    return body as { mandateId: string; mandateVersion: number; expiresAt: number };
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

  async getGatewaySettings(): Promise<GatewaySettings> {
    const res = await this.fetch('/api/gateway-settings');
    if (!res.ok) throw new Error(`Failed to load settings: ${res.status}`);
    return res.json();
  }

  /** The data folder the running gateway actually uses (read-only). */
  async getDataFolder(): Promise<{ dataDir: string }> {
    const res = await this.fetch('/api/gateway-settings/data-folder');
    if (!res.ok) throw new Error(`Failed to load data folder: ${res.status}`);
    return res.json();
  }

  /** Returns the PERSISTED state, so callers render backend truth. */
  async setGatewaySettings(patch: Partial<GatewaySettings>): Promise<GatewaySettings> {
    const res = await this.fetch('/api/gateway-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Failed to save settings: ${res.status}`);
    return res.json();
  }

  // ─── Archived mandates (local display flag; deletes nothing) ───

  /** Ids of mandates the person replaced whose revoke on the AS is still open (no longer used here). */
  async getReplacedMandates(): Promise<string[]> {
    const res = await this.fetch('/api/replaced-mandates');
    if (!res.ok) throw new Error(`Failed to load replaced mandates: ${res.status}`);
    const body = (await res.json()) as { entries?: Array<{ authorizationId?: unknown }> };
    return (body.entries ?? []).map((e) => e.authorizationId).filter((id): id is string => typeof id === 'string');
  }

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

  // ─── Blocked actions: local "last seen" flag (deletes nothing) ───

  async getLastSeenBlockedAt(): Promise<number> {
    const res = await this.fetch('/api/blocked-seen');
    if (!res.ok) throw new Error(`Failed to load last-seen: ${res.status}`);
    return ((await res.json()) as { lastSeenBlockedAt: number }).lastSeenBlockedAt;
  }

  /** Returns the PERSISTED cutoff, so callers render backend truth. */
  async markBlockedSeen(ts: number = Date.now()): Promise<number> {
    const res = await this.fetch('/api/blocked-seen', {
      method: 'POST',
      body: JSON.stringify({ ts }),
    });
    if (!res.ok) throw new Error(`Failed to mark blocked seen: ${res.status}`);
    return ((await res.json()) as { lastSeenBlockedAt: number }).lastSeenBlockedAt;
  }

  // ─── Report: local "last seen" flag (reports mockup; deletes nothing) ───

  async getLastSeenReportAt(): Promise<number> {
    const res = await this.fetch('/api/report-seen');
    if (!res.ok) throw new Error(`Failed to load last-seen report: ${res.status}`);
    return ((await res.json()) as { lastSeenReportAt: number }).lastSeenReportAt;
  }

  /** Returns the PERSISTED cutoff, so callers render backend truth. */
  async markReportSeen(ts: number = Date.now()): Promise<number> {
    const res = await this.fetch('/api/report-seen', { method: 'POST', body: JSON.stringify({ ts }) });
    if (!res.ok) throw new Error(`Failed to mark report seen: ${res.status}`);
    return ((await res.json()) as { lastSeenReportAt: number }).lastSeenReportAt;
  }

  // ─── Tickets: local "last seen" flag (UI spec §12.3; deletes nothing) ───

  async getLastSeenTicketsAt(): Promise<number> {
    const res = await this.fetch('/api/tickets-seen');
    if (!res.ok) throw new Error(`Failed to load last-seen tickets: ${res.status}`);
    return ((await res.json()) as { lastSeenTicketsAt: number }).lastSeenTicketsAt;
  }

  /** Returns the PERSISTED cutoff, so callers render backend truth. */
  async markTicketsSeen(ts: number = Date.now()): Promise<number> {
    const res = await this.fetch('/api/tickets-seen', {
      method: 'POST',
      body: JSON.stringify({ ts }),
    });
    if (!res.ok) throw new Error(`Failed to mark tickets seen: ${res.status}`);
    return ((await res.json()) as { lastSeenTicketsAt: number }).lastSeenTicketsAt;
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
    const res = await this.sendConfirmed(`/vault/credentials/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(fields),
    }, { route: 'credentials', op: 'put-merge', fields });
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

  async getIntegrationManifests(): Promise<{ manifests: IntegrationManifest[]; signInGroups?: SignInGroup[]; builtins?: IntegrationManifest[] }> {
    const res = await this.fetch('/mcp/integrations/manifests');
    if (!res.ok) throw new Error(`Failed to fetch manifests: ${res.status}`);
    return res.json();
  }

  /**
   * For LABELS only (action labels, system names on tickets and approvals):
   * the connector manifests plus the gateway's built-in tool groups' names
   * (report, setup). Never use this list to render connectors — a built-in
   * is not one.
   */
  async getLabelManifests(): Promise<IntegrationManifest[]> {
    const { manifests, builtins } = await this.getIntegrationManifests();
    return [...(manifests ?? []), ...(builtins ?? [])];
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
  async getToolDisplay(): Promise<Record<string, import('@suveren/approval-card/lib/approval-view').ToolDisplay>> {
    const res = await this.fetch('/tool-display');
    if (!res.ok) return {};
    const data = await res.json();
    return (data?.tools ?? {}) as Record<string, import('@suveren/approval-card/lib/approval-view').ToolDisplay>;
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
  ): Promise<{ status: string; receipt?: unknown }> {
    const { noteEncrypted, contentHash, shownHash, note, ...rest } = opts ?? {};
    const res = await this.fetch(this.decisionPath(id, 'resolve'), {
      method: 'POST',
      body: JSON.stringify({
        action,
        domain,
        ...rest,
        // Mutually exclusive on the wire: a sealed note replaces the plain one.
        ...(noteEncrypted ? { note_encrypted: noteEncrypted } : (note ? { note } : {})),
        // v0.8 (protocol.md → Proposals, rule 8): every decision carries the
        // fingerprint. `proposalContentHash` is the wire name; `content_hash`
        // is what today's AS reads — both through the transition.
        ...(contentHash ? { content_hash: contentHash, proposalContentHash: contentHash } : {}),
        ...(shownHash ? { shown_hash: shownHash } : {}),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      throw new Error(this.decisionError(err, `Failed: ${res.status}`));
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
    if (contentHash) { body.content_hash = contentHash; body.proposalContentHash = contentHash; } // v0.8 wire name beside the legacy one
    if (shownHash) body.shown_hash = shownHash;
    const res = await this.fetch(this.decisionPath(id, 'approve'), {
      method: 'POST',
      body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      throw new Error(this.decisionError(err, `approveProposal failed: ${res.status}`));
    }
    return res.json();
  }

  /**
   * Reject a proposal — the above-cap approver path (requires the caller to
   * be in `pendingApprovers`; the proposer's OWN proposal uses
   * {@link withdrawProposal} instead, a separate route, since TR5
   * deliberately excludes the proposer from that list — see its doc
   * comment). SP endpoint: POST /api/proposals/:id/reject — accepts the
   * legacy `{ reason }` body (older gateways) as well as the RJ1–RJ6
   * contract `{ outcome?, note? }` (temp/briefs/rj-reject-brief.md).
   * `reason` and `outcome`/`note` are mutually exclusive callers in this
   * codebase — no call site here needs both at once.
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
    if (contentHash) { body.content_hash = contentHash; body.proposalContentHash = contentHash; } // v0.8 wire name beside the legacy one
    if (shownHash) body.shown_hash = shownHash;
    const res = await this.fetch(this.decisionPath(id, 'reject'), {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      throw new Error(this.decisionError(err, `rejectProposal failed: ${res.status}`));
    }
    return res.json();
  }

  /**
   * GET /api/proposals?creator=me (suveren-as#89) — the caller's OWN
   * still-pending proposals (above-cap or not), active workspace only,
   * same encrypted-content shape as every other list mode. Returns `null`
   * on a 400 — the one way to tell an older AS that does not support this
   * mode yet (its `GET /api/proposals` 400s with no `creator`/`domain`/
   * `status`/`approver` match) from "genuinely nothing pending" (`[]`).
   * Callers MUST fall back to something else on `null`, never show an
   * empty list as if it were authoritative.
   */
  async getProposalsCreatedByMe(): Promise<Proposal[] | null> {
    const res = await this.fetch('/api/proposals?creator=me');
    if (res.status === 400) return null;
    if (!res.ok) throw new Error(`Failed to fetch my proposals: ${res.status}`);
    const data = await res.json();
    return (data.proposals ?? []) as Proposal[];
  }

  /**
   * POST /api/proposals/:id/withdraw (suveren-as#89) — the proposal's own
   * creator declines to pursue their still-pending above-cap action. The
   * ONLY way the proposer can end their own proposal: `rejectProposal`
   * requires `pendingApprovers` membership, which TR5 deliberately excludes
   * them from. Same note/encrypted-note shape as {@link rejectProposal}
   * (mutually exclusive — a sealed note replaces the plain one) and the
   * same `content_hash`/`shown_hash` fingerprint parameters as every other
   * decision here.
   */
  async withdrawProposal(
    id: string,
    opts?: { note?: string; noteEncrypted?: NoteEncryptedWire },
    contentHash?: string,
    shownHash?: string,
  ): Promise<{ status: string; proposalId: string; withdrawnBy: { userId: string; at: number; note?: string; noteEncrypted?: NoteEncryptedWire } }> {
    const { noteEncrypted, note } = opts ?? {};
    const body: Record<string, unknown> = {
      ...(noteEncrypted ? { note_encrypted: noteEncrypted } : (note ? { note } : {})),
    };
    if (contentHash) { body.content_hash = contentHash; body.proposalContentHash = contentHash; } // v0.8 wire name beside the legacy one
    if (shownHash) body.shown_hash = shownHash;
    const res = await this.fetch(this.decisionPath(id, 'withdraw'), {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      throw new Error(this.decisionError(err, `withdrawProposal failed: ${res.status}`));
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
   * UI spec §15.2 — one attachment's live preview for a pending proposal's
   * approval card: gateway-internal, read-only, never stored on the
   * proposal itself. `sha256` is the fingerprint already shown (sealed) on
   * this proposal's own `_attachmentsSealed` meta.
   */
  async getProposalAttachmentPreview(id: string, sha256: string): Promise<AttachmentPreviewResult> {
    const res = await this.fetch(`/proposal-status/${encodeURIComponent(id)}/attachment-preview/${encodeURIComponent(sha256)}`);
    if (!res.ok) throw new Error(`Failed to fetch attachment preview: ${res.status}`);
    return res.json();
  }

  /** Same as `getProposalAttachmentPreview`, for an opened ticket's own
   *  local receipt archive entry (UI spec §15.2, ticket view). */
  async getReceiptAttachmentPreview(receiptId: string, sha256: string): Promise<AttachmentPreviewResult> {
    const res = await this.fetch(`/api/evidence/receipt/${encodeURIComponent(receiptId)}/attachment-preview/${encodeURIComponent(sha256)}`);
    if (!res.ok) throw new Error(`Failed to fetch attachment preview: ${res.status}`);
    return res.json();
  }

  /**
   * One mandate's summary. `cumulative_usage` is additive: the Authority
   * Server sends it only to an active member of the mandate's group, with the
   * TEAM-wide count per cumulative bound and action type (`used`) and the
   * limit the ticket enforces (`limit`, null if none). Absent → null here.
   * SP endpoint: GET /api/authorizations/:id
   */
  async getAuthorizationUsage(authorizationId: string): Promise<CumulativeUsageEntry[] | null> {
    const res = await this.fetch(`/api/authorizations/${encodeURIComponent(authorizationId)}`);
    if (!res.ok) return null;
    const body = await res.json().catch(() => null) as { cumulative_usage?: unknown } | null;
    return Array.isArray(body?.cumulative_usage) ? (body!.cumulative_usage as CumulativeUsageEntry[]) : null;
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

  /** A dry run of the give on a chain gateway: what would be granted and what would be refused before the touch. Writes and touches nothing. */
  async prepareMandate(request: Record<string, unknown>): Promise<{ ok: true; prepared: PreparedMandate } | { ok: false; message: string; code?: string }> {
    try {
      const res = await this.fetch('/api/mandate/prepare', { method: 'POST', body: JSON.stringify(request) });
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (res.ok) return { ok: true, prepared: body as unknown as PreparedMandate };
      return { ok: false, message: asErrorMessage(body, `Preparing failed: ${res.status}`), code: (body.grantCode ?? body.code) as string | undefined };
    } catch { return { ok: false, message: 'The gateway could not be reached.', code: 'offline' }; }
  }

  /** Sign a mandate through the control plane: the same steps as the AI path. */
  async signMandate(request: {
    team: string;
    profile: string;
    limits: Record<string, string | number>;
    scope: Record<string, string | number>;
    contextLabels?: Record<string, Record<string, string>>;
    intent: string;
    mode: 'review' | 'automatic';
    ttlSeconds: number;
    title: string;
    discloseIdentity: boolean;
    replaces?: string;
    /** A chain gateway: the hash of the plan `prepareMandate` returned for this request. */
    planHash?: string;
    /** The AI proposal this give carries out: its give waiting on the phone is dropped (given here instead). */
    fromProposal?: string;
  }): Promise<{ authorizationId: string; revokeError?: string }> {
    const res = await this.fetch('/api/mandate/sign', { method: 'POST', body: JSON.stringify(request) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const b = body as { code?: string; grantCode?: string; approvers?: unknown; reason?: string };
      throw new MandateSignError(asErrorMessage(body, `Signing failed: ${res.status}`), b.grantCode ?? b.code, res.status, Array.isArray(b.approvers) ? b.approvers as MandateSignError['approvers'] : undefined, b.reason, approverIdsOf(body));
    }
    return body as { authorizationId: string; revokeError?: string };
  }

  /**
   * Give on the phone (DEC-90): the same prepared plan as `signMandate` (echo `planHash`), sealed to the person's devices; nothing is granted
   * here. A refusal throws {@link MandateSignError} like a give.
   */
  async giveOnPhone(request: Record<string, unknown> & { planHash: string; fromProposal?: string }): Promise<{ mandateId: string; mandateVersion: number; expiresAt: number }> {
    const res = await this.fetch('/api/mandate/give-on-phone', { method: 'POST', body: JSON.stringify(request) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const b = body as { code?: string; grantCode?: string; reason?: string };
      throw new MandateSignError(asErrorMessage(body, `Sending to your phone failed: ${res.status}`), b.grantCode ?? b.code, res.status, undefined, b.reason, approverIdsOf(body));
    }
    return body as { mandateId: string; mandateVersion: number; expiresAt: number };
  }

  /** Has the phone given it? `waiting`, `unknown` (nothing waits under this id), or `done` once the mandate is issued. A refusal throws. */
  async pollGiveOnPhone(mandateId: string): Promise<{ state: 'waiting' } | { state: 'unknown' } | { state: 'done'; authorizationId: string; revokeError?: string }> {
    const res = await this.fetch(`/api/mandate/give-on-phone/${encodeURIComponent(mandateId)}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const b = body as { code?: string; grantCode?: string; reason?: string };
      throw new MandateSignError(asErrorMessage(body, `Checking your phone failed: ${res.status}`), b.grantCode ?? b.code, res.status, undefined, b.reason, approverIdsOf(body));
    }
    return body as { state: 'waiting' } | { state: 'unknown' } | { state: 'done'; authorizationId: string; revokeError?: string };
  }


  /** Stop waiting for the phone on this page. The prepared request runs out at the Authority Server by itself. */
  async cancelGiveOnPhone(mandateId: string): Promise<void> {
    await this.fetch(`/api/mandate/give-on-phone/${encodeURIComponent(mandateId)}`, { method: 'DELETE' }).catch(() => {});
  }

  /** Extend a mandate: only its expiry moves. */
  async renewMandate(request: {
    authorizationId: string;
    profileId: string;
    groupId: string;
    bounds: Record<string, string | number>;
    context: Record<string, string | number>;
    intent: string;
    mode: 'review' | 'automatic';
    domain: string;
    ttlSeconds: number;
    path?: string;
  }): Promise<void> {
    const res = await this.fetch('/api/mandate/renew', { method: 'POST', body: JSON.stringify(request) });
    if (!res.ok) throw new Error(asErrorMessage(await res.json().catch(() => ({})), `Extending failed: ${res.status}`));
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

/**
 * The signed-in person from their personal workspace's detail. The Authority Server answers `{ group, members, isAdmin }` with each
 * member's `userId` (not `id`): reading `id` alone found nobody, so a gateway with device keys could never finish an unlock in the
 * browser ("This did not work"). The owner of the personal workspace is the person; a single member is taken when no owner is named.
 */
export function sessionUserFromGroup(detail: unknown): SPUser | null {
  const d = (detail ?? {}) as { group?: { ownerUserId?: unknown }; ownerUserId?: unknown; members?: Array<Record<string, unknown>> };
  const members = Array.isArray(d.members) ? d.members : [];
  const idOf = (m: Record<string, unknown>): string => (typeof m.userId === 'string' && m.userId) || (typeof m.id === 'string' && m.id) || '';
  const owner = typeof d.group?.ownerUserId === 'string' ? d.group.ownerUserId : typeof d.ownerUserId === 'string' ? d.ownerUserId : null;
  const me = owner ? members.find((m) => idOf(m) === owner) : members.length === 1 ? members[0] : undefined;
  if (!me || !idOf(me)) return null;
  return { id: idOf(me), name: typeof me.name === 'string' ? me.name : '', email: typeof me.email === 'string' ? me.email : '', did: '' };
}
