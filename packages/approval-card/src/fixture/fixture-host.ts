/**
 * A host for the approval card that needs no gateway: reads come from memory,
 * and anything the fixture does not have rejects (the card then shows what it
 * shows when a read fails — never an invented value).
 */
import { createElement, type ReactNode } from 'react';
import { configureApprovalHost, type ApprovalHost } from '../host';
import { FIXTURE_PLAIN_PROPOSAL, FIXTURE_SEALED_PROPOSAL, FIXTURE_TOOL_ARGS } from './fixture-proposal';

const unavailable = (what: string) => () => Promise.reject(new Error(`fixture host: ${what} is not available`));

function FixtureLink(props: { to: string; className?: string; children?: ReactNode }) {
  return createElement('a', { href: props.to, className: props.className }, props.children);
}

export const fixtureHost: ApprovalHost = {
  data: {
    // Stands in for opening a sealed payload with this device's key.
    decryptProposalContent: async (wire) => {
      if (wire.ciphertext === 'fixture-ciphertext') return { plaintext: JSON.stringify(FIXTURE_TOOL_ARGS) };
      throw new Error('fixture host: no key wrap for this payload');
    },
    decryptIntent: unavailable('decryptIntent'),
    getGateContent: async () => null,
    getAttestationIntent: async () => null,
    getProposal: async (id) => {
      const p = [FIXTURE_PLAIN_PROPOSAL, FIXTURE_SEALED_PROPOSAL].find((x) => x.id === id);
      if (!p) throw new Error('fixture host: unknown proposal');
      return p;
    },
    saveShownSnapshot: async () => ({ shownHash: 'sha256:fixture' }),
    getProposalAttachmentPreview: unavailable('attachment preview'),
    getProposalPreview: unavailable('preview'),
    getProposalRequestContext: unavailable('request context'),
    listProfiles: async () => [],
    getProfile: unavailable('profile'),
    getEnrichedAuthorizations: async () => [],
    getIntegrationManifests: async () => ({ manifests: [] }),
    getLabelManifests: async () => [],
    getMyReceiptsPage: unavailable('receipts'),
    getAuthorizationUsage: async () => null,
    getTeamProfileConfig: async () => null,
  },
  useSession: () => ({ mode: 'personal', group: null, groupId: null, domain: 'owner' }),
  useServerEvent: () => { /* no event stream in a bare page */ },
  useSimulationMode: () => false,
  useOpenMandateScreen: () => null,
  Link: FixtureLink,
};

export function configureFixtureHost(): void {
  configureApprovalHost(fixtureHost);
}
