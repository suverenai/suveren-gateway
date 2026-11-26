/**
 * The card-parity page: ?case=<id>&card=gateway|phone. The SAME proposal drawn by the gateway's approval card (ApprovalCard, with a host
 * that answers from memory) or by the phone app's give (GiveCard). Used by e2e/card-parity.spec.ts and to look at the real built UI.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentProfile, MandatePayload } from '@hap/core';
import '../../ui/src/styles/tokens.css';
import '../../ui/src/styles/design-system.css';
import { configureApprovalHost, type ApprovalHost } from '../../../packages/approval-card/src/host';
import { fixtureHost } from '../../../packages/approval-card/src/fixture/fixture-host';
import { ApprovalCard } from '../../../packages/approval-card/src/components/ApprovalCard';
import type { Proposal, PreviewResponse, RequestContextResponse } from '../../../packages/approval-card/src/types';
import { MemoryRouter } from 'react-router-dom';
import { GiveCard, OwnMandates } from '../src/screens/Mandates';
import { RequestPanel } from '../src/screens/RequestPanel';
import { PhoneTop } from '../src/screens/PhoneTop';
import { AuthCard } from '../../ui/src/pages/AuthorizationsPage';
import type { GiveItem } from '../src/lib/mandate-give';
import { CASES, type ParityCase } from './cases';

declare const __PROFILES__: Record<string, AgentProfile>;

const params = new URLSearchParams(location.search);
const c: ParityCase = CASES.find((x) => x.id === params.get('case')) ?? CASES[0];
const card = (['phone', 'list', 'phone-list', 'phone-panel', 'phone-top'] as const).find((x) => x === params.get('card')) ?? 'gateway';
const profile = __PROFILES__[`${c.folder}@${c.version}`];
const NOW = Math.floor(Date.now() / 1000);

const none: RequestContextResponse = { request: { status: 'none' }, history: { status: 'no_customer_link' } };
const requestContext: RequestContextResponse = c.request ? {
  request: { status: 'ok', connector: 'email', kind: 'message', implicit: false, author: 'Maria Muster <maria@example.com>', at: new Date((NOW - 3600) * 1000).toISOString(), title: 'Question about the studio hours', body: 'Hello, are you open on Saturdays?', chain: [] },
  history: { status: 'no_customer_link' },
} : none;

const args = { profile: c.folder, limits: c.limits, scope: c.scope, intent: c.intent, mode: c.mode, duration_hours: c.durationHours, title: c.title };
const proposal: Proposal = {
  id: 'parity-proposal', authorizationId: 'auth-setup-1', profileId: 'github.com/humanagencyprotocol/hap-profiles/delegation@0.6', path: 'delegation/create',
  pendingDomains: ['owner'], committedBy: {}, rejectedBy: null, tool: 'setup__create_mandate', executionContext: {}, status: 'pending', executionResult: null,
  createdAt: NOW - 120, expiresAt: NOW + 3600, createdBy: 'fixture-owner', toolArgs: args,
};

const preview: PreviewResponse = {
  status: 'ok', integration: 'setup', tool: 'describe_mandate_proposal', readAt: NOW * 1000, describesProposal: true,
  body: { structured: {
    proposal: `New mandate · ${profile.name}`, profile_version: `${c.folder} ${profile.version}`, workspace: 'Personal', mode: c.mode, title: c.title, intent: c.intent,
    checks: [`${profile.name} is allowed by your Setup mandate`, `${c.mode} — within the modes your Setup mandate allows`, 'Proposals today: 1 of 10'],
  } },
};

const short = (id: string) => id.replace(/@.*$/, '').split('/').pop();
const host: ApprovalHost = {
  ...fixtureHost,
  data: {
    ...fixtureHost.data,
    listProfiles: async () => Object.values(__PROFILES__).map((p) => ({ id: p.id, name: p.name ?? short(p.id), version: p.version } as never)),
    getProfile: async (id: string) => Object.values(__PROFILES__).find((p) => p.id === id) ?? Promise.reject(new Error('unknown profile')),
    getProposal: async () => proposal,
    getProposalPreview: async () => preview,
    getProposalRequestContext: async () => requestContext,
  },
};
configureApprovalHost(host);

const item: GiveItem = {
  key: 'give:parity:1', mandateId: 'parity', version: 1, op: 'grant', preparedBy: 'Office Mac', preparedAt: NOW - 120, title: c.title,
  profile, bounds: { profile: profile.id, ...c.limits }, scope: c.scope, intent: c.intent,
  payload: { commitment_mode: c.mode, issued_at: NOW, expires_at: NOW + c.durationHours * 3600 } as unknown as MandatePayload,
  members: {}, expiresAt: NOW + c.durationHours * 3600, lastsSeconds: c.durationHours * 3600, proposalId: 'parity-proposal', workspace: 'Personal',
  requestContext,
};

const noop = () => undefined;
const wrap = { maxWidth: params.get('max') ? Number(params.get('max')) : 640, margin: '0 auto' } as const;

async function boot() {
  if (card === 'phone' || card === 'phone-list' || card === 'phone-panel' || card === 'phone-top') await import('../src/approve.css');
  const listItem = {
    authorization_id: 'auth-list-1', profile_id: profile.id, path: 'x', title: c.title, sp_status: 'active', frame: { profile: profile.id, ...c.limits },
    required_domains: ['owner'], attested_domains: ['owner'], missing_domains: [], deferred_commitment_domains: c.mode === 'review' ? ['owner'] : [],
    created_at: new Date((NOW - 20 * 86400) * 1000).toISOString(), earliest_expiry: new Date((NOW + 30 * 86400) * 1000).toISOString(), remaining_seconds: 30 * 86400,
    approvers_frozen: [], above_cap: false,
  } as never;
  const noop2 = () => undefined;
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <main style={wrap} data-testid={`parity-${card}`}>
        {card === 'list' ? (
          <MemoryRouter>
            <AuthCard
              item={listItem} revokedSet={new Set()} expandedHash={null} gateCache={{}} gateLoading={null} copiedHash={null} revokingHash={null} copyingHash={null}
              profileConfigCache={new Map()} area={profile.name ?? c.folder} mode="personal" activeDomain="owner" group={null} groupId={null}
              onExpand={noop2} onCopyHash={noop2} onCopy={noop2} onRevoke={noop2} onExtend={noop2} scope={c.scope}
            />
          </MemoryRouter>
        ) : card === 'phone-list' ? (
          <OwnMandates items={[{ authorizationId: 'a', mandateId: 'm', version: 1, title: c.title, expiresAt: NOW + 30 * 86400, mode: c.mode, fields: {}, givenOn: null, givenAt: null }]} nowSeconds={NOW} onEnd={noop2} />
        ) : card === 'phone-top' ? (
          <div className="ap-shell"><PhoneTop /><h1 style={{ padding: '0 var(--space-3)' }}>Your mandates</h1></div>
        ) : card === 'phone-panel' ? (
          <RequestPanel position={{ index: 1 }} total={2} prevId={null} nextId="x" onMove={noop} onLater={noop} autoOpen onToggleAuto={noop} shown={null} other={{ key: 'give:parity:1', node: <GiveCard state={{ step: 'review', item }} nowSeconds={NOW} onGive={noop} onLater={noop} onReject={async () => ({})} onAskChanges={async () => ({})} onCancelTouch={noop} onCheckAgain={noop} onDone={noop} dismissLabel="Next" /> }} />
        ) : card === 'phone'
          ? <GiveCard state={{ step: 'review', item }} nowSeconds={NOW} onGive={noop} onLater={noop} onReject={async () => ({})} onAskChanges={async () => ({})} onCancelTouch={noop} onCheckAgain={noop} onDone={noop} dismissLabel="Next" />
          : <ApprovalCard proposal={proposal} currentUserId="fixture-owner" decide={async () => ({})} />}
      </main>
    </StrictMode>,
  );
}
void boot();
