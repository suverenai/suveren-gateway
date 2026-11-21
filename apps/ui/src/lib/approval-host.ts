/**
 * Wires the shared approval card (packages/approval-card) to this gateway page:
 * the control-plane client, the session, the event stream and the router.
 * Imported once from main.tsx, before the first render.
 */
import { createElement, type ReactNode } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { configureApprovalHost } from '@suveren/approval-card/host';
import { spClient } from './sp-client';
import { useAuth } from '../contexts/AuthContext';
import { useSSEEvent, type SSEEventType } from '../contexts/EventSourceContext';
import { useSimulationMode } from '../hooks/useSimulationMode';
import { useDeviceChain } from './use-device-chain';
import { useCardMandateGive } from './card-give';

function HostLink(props: { to: string; className?: string; children?: ReactNode }) {
  return createElement(Link, props);
}

configureApprovalHost({
  data: {
    decryptProposalContent: (wire) => spClient.decryptProposalContent(wire),
    decryptIntent: (params) => spClient.decryptIntent(params),
    getGateContent: (path) => spClient.getGateContent(path),
    getAttestationIntent: (id) => spClient.getAttestationIntent(id),
    getProposal: (id) => spClient.getProposal(id),
    saveShownSnapshot: (id, snapshot) => spClient.saveShownSnapshot(id, snapshot),
    getProposalAttachmentPreview: (id, sha256) => spClient.getProposalAttachmentPreview(id, sha256),
    getProposalPreview: (id) => spClient.getProposalPreview(id),
    getProposalRequestContext: (id) => spClient.getProposalRequestContext(id),
    listProfiles: () => spClient.listProfiles(),
    getProfile: (id) => spClient.getProfile(id),
    getEnrichedAuthorizations: () => spClient.getEnrichedAuthorizations(),
    getIntegrationManifests: () => spClient.getIntegrationManifests(),
    getLabelManifests: () => spClient.getLabelManifests(),
    getMyReceiptsPage: (options) => spClient.getMyReceiptsPage(options),
    getAuthorizationUsage: (id) => spClient.getAuthorizationUsage(id),
    getTeamProfileConfig: (groupId, profileId) => spClient.getTeamProfileConfig(groupId, profileId),
  },
  useSession() {
    const { mode, group, groupId, domain } = useAuth();
    return { mode, group, groupId, domain };
  },
  useServerEvent(type, handler) {
    useSSEEvent(type as SSEEventType, handler);
  },
  useSimulationMode,
  useGiveWording: useDeviceChain,
  // One give driver for the card and the give page (lib/use-give.ts): "Give this mandate" runs in place.
  useMandateGive: useCardMandateGive,
  useOpenMandateScreen() {
    const navigate = useNavigate();
    return (handoff) => {
      for (const [key, value] of handoff) sessionStorage.setItem(key, value);
      navigate('/mandates/new/intent');
    };
  },
  Link: HostLink,
});
