/**
 * Wires the SHARED approval card (packages/approval-card) to the phone: ONE card for every device (the gateway page uses the same).
 * The card knows nothing of where it runs; this file is the phone's side of the host seam (host.ts of the package).
 *
 * What the phone can answer: the proposal itself (from the Authority Server, with the phone's session), and opening sealed
 * content with this phone's reading key. Everything the gateway page answers from the gateway's own local data (profiles,
 * connector manifests, receipts, previews, the shown-hash snapshot) the phone does not have, so those reads REJECT and the card
 * shows what it shows when a read fails: the arguments in full, never an invented value. The card context the gateway sealed
 * (display rules, the mapping to the execution context) is opened by content.ts; turning it into the card's richer layout, and
 * rebuilding the execution context from it, belong to the checks before a decision (stage D2).
 *
 * The card never calls `fetch`. Nothing the AI wrote can reach the person through this seam.
 */
import { createElement, type ReactNode } from 'react';
import { configureApprovalHost, type ApprovalHost, type SealedWire } from '@suveren/approval-card/host';
import type { DeviceKeyStore } from './key-store';
import type { ProposalReader } from './proposals';
import { openContent, type ContentWire } from './content';

/** What the host needs once the phone has a session. Set by the app after sign-in, cleared when the session ends. */
export interface Bound {
  reader: ProposalReader;
  keys: DeviceKeyStore;
  ownKeyId: string;
  userId: string;
}

let bound: Bound | null = null;

export function bindPhoneHost(b: Bound | null): void {
  bound = b;
}

function live(): Bound {
  if (!bound) throw new Error('The app is not signed in.');
  return bound;
}

const unavailable = (what: string) => (): Promise<never> => Promise.reject(new Error(`This phone does not have ${what}.`));

function PhoneLink(props: { to: string; className?: string; children?: ReactNode }) {
  // The phone has no pages of the gateway to link to.
  return createElement('span', { className: props.className }, props.children);
}

export const phoneHost: ApprovalHost = {
  data: {
    // `wire` is the whole `content` object of the proposal; its `device_keys` holds this phone's own entry.
    decryptProposalContent: async (wire: SealedWire) => {
      const b = live();
      const { plaintext } = await openContent(wire as unknown as ContentWire, b.ownKeyId, b.keys);
      return { plaintext };
    },
    decryptIntent: unavailable('a mandate\'s why'),
    getGateContent: async () => null,
    getAttestationIntent: async () => null,
    // The card reads the proposal again on its own timer: that is polling, and polling never counts as use of the session.
    getProposal: async (id) => {
      const r = await live().reader.get(id, false);
      if (!r.ok) throw new Error('The request could not be read.');
      return r.data;
    },
    saveShownSnapshot: unavailable('the shown-hash store (decisions come in a later version)'),
    getProposalAttachmentPreview: unavailable('attachment previews'),
    getProposalPreview: unavailable('previews'),
    getProposalRequestContext: unavailable('the record behind this request'),
    listProfiles: async () => [],
    getProfile: unavailable('profiles'),
    getEnrichedAuthorizations: async () => [],
    getIntegrationManifests: async () => ({ manifests: [] }),
    getLabelManifests: async () => [],
    getMyReceiptsPage: unavailable('tickets'),
    getAuthorizationUsage: async () => null,
    getTeamProfileConfig: async () => null,
  },
  useSession: () => ({ mode: 'personal', group: null, groupId: null, domain: bound?.userId ?? '' }),
  // No event stream: the list refreshes by timer and on the person's action.
  useServerEvent: () => { /* nothing */ },
  // Unknown on a phone: the card treats null as "not known yet".
  useSimulationMode: () => null,
  useOpenMandateScreen: () => null,
  Link: PhoneLink,
};

/** Call once, before the first render. */
export function configurePhoneHost(): void {
  configureApprovalHost(phoneHost);
}
