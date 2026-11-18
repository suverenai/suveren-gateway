/**
 * The host seam of the approval card.
 *
 * The card and the code that decrypts proposal content know nothing about the
 * gateway's control-plane URL, router, session or event stream. Whoever renders
 * them — the gateway page (apps/ui) or the phone app (apps/approve) — calls
 * `configureApprovalHost(...)` once, before the first render, with:
 *   - `data`: the reads the card needs (and the one decrypt call);
 *   - a few React hooks (session, server events, navigation, simulation flag);
 *   - a link component.
 *
 * The card never calls `fetch` itself. Everything it shows comes from `data`
 * or from the proposal it was given as a prop. The card shows only what is
 * bound (the proposal) plus the host's own local data; nothing in this seam
 * lets a caller add free text for the approver.
 *
 * Hook members are called during render, always in the same order, so a host
 * must pass stable functions (module-level, not created per render).
 */
import type { ComponentType, ReactNode } from 'react';
import type {
  CumulativeUsageEntry,
  EnrichedAuthorizationEntry,
  GateContentEntry,
  IntegrationManifest,
  PreviewResponse,
  ProfileConfig,
  ProfileSummary,
  Proposal,
  ReceiptPage,
  RequestContextResponse,
  ShownSnapshotPayload,
  SignInGroup,
} from './types';
import type { AttachmentPreviewResult } from './lib/attachment-sealed';

/** A sealed payload as it travels on the wire (proposal `content`, a change-needed note). */
export interface SealedWire {
  ciphertext: string;
  keys: Record<string, { ct: string; enc: string }>;
}

export interface ApprovalHostData {
  /** Opens a sealed payload with THIS device's own key. Rejects when this device has no wrap for it. */
  decryptProposalContent(wire: SealedWire): Promise<{ plaintext: string }>;
  decryptIntent(params: { intentCiphertext: string; encryptedKey: { ct: string; enc: string }; approverId: string }): Promise<string>;
  getGateContent(path: string): Promise<GateContentEntry | null>;
  getAttestationIntent(authorizationId: string): Promise<{
    intentCiphertext: string;
    encryptedKey: { ct: string; enc: string };
    approversFrozen: string[];
  } | null>;
  getProposal(id: string): Promise<Proposal>;
  saveShownSnapshot(id: string, snapshot: ShownSnapshotPayload): Promise<{ shownHash: string }>;
  getProposalAttachmentPreview(id: string, sha256: string): Promise<AttachmentPreviewResult>;
  getProposalPreview(id: string): Promise<PreviewResponse>;
  getProposalRequestContext(id: string): Promise<RequestContextResponse>;
  listProfiles(): Promise<ProfileSummary[]>;
  /** The full profile (schema) for an id. */
  getProfile(id: string): Promise<any>;
  getEnrichedAuthorizations(): Promise<EnrichedAuthorizationEntry[]>;
  getIntegrationManifests(): Promise<{ manifests: IntegrationManifest[]; signInGroups?: SignInGroup[]; builtins?: IntegrationManifest[] }>;
  getLabelManifests(): Promise<IntegrationManifest[]>;
  getMyReceiptsPage(options?: { before?: string; profile?: string; limit?: number }): Promise<ReceiptPage>;
  getAuthorizationUsage(authorizationId: string): Promise<CumulativeUsageEntry[] | null>;
  getTeamProfileConfig(groupId: string, profileId: string): Promise<ProfileConfig | null>;
}

export interface ApprovalHostSession {
  mode: 'personal' | 'team';
  group: { id: string; name: string; isPersonal?: boolean } | null;
  groupId: string | null;
  domain: string;
}

/** The pieces of a hand-off to the host's own mandate screen, written in this order. */
export type MandateScreenHandoff = Array<[key: string, value: string]>;

export interface ApprovalHost {
  data: ApprovalHostData;
  /** Who is looking: the active workspace and domain. */
  useSession(): ApprovalHostSession;
  /** Calls `handler` each time the host's event stream delivers `type`. A host without a stream does nothing. */
  useServerEvent(type: string, handler: (payload: unknown) => void): void;
  /** The gateway-wide simulation flag; null until known. */
  useSimulationMode(): boolean | null;
  /**
   * Returns the function that opens the host's mandate screen pre-filled
   * ("Edit before signing", "Change it myself"), or null when the host has no
   * such screen — then those two links are not shown.
   */
  useOpenMandateScreen(): ((handoff: MandateScreenHandoff) => void) | null;
  /** A link to a page of the host (`to` is a host path). */
  Link: ComponentType<{ to: string; className?: string; children?: ReactNode }>;
}

let configured: ApprovalHost | null = null;

export function configureApprovalHost(host: ApprovalHost): void {
  configured = host;
}

/** The configured host. Throws when none was set: fail visibly, never serve a guess. */
export function approvalHost(): ApprovalHost {
  if (!configured) throw new Error('approval-card: configureApprovalHost() was not called before the card rendered');
  return configured;
}

/** Shorthand for the data side. */
export function hostData(): ApprovalHostData {
  return approvalHost().data;
}
