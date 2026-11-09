import { createRoot } from 'react-dom/client';
import '../src/styles/tokens.css';
import '../src/styles/design-system.css';
import { MemoryRouter } from 'react-router-dom';
import { spClient } from '../src/lib/sp-client';
import email from './email.json';
import { ActionCard } from '../src/components/ActionCard';
import { NoTicketRow } from '../src/components/NoTicketRow';
import { BoundsEditor } from '../src/components/BoundsEditor';
import { SharedLimitRows } from '../src/components/SharedLimitRows';

const q = new URLSearchParams(location.search);
document.documentElement.dataset.theme = q.get('theme') ?? 'light';
const withWords = q.get('words') !== '0';
const profile: any = JSON.parse(JSON.stringify(email));
profile.id = 'github.com/humanagencyprotocol/hap-profiles/email@0.10';
if (withWords) { ; }
const full = q.get('data') !== '0';
const now = Math.floor(Date.now() / 1000);
const sc = spClient as any;
sc.listProfiles = async () => [{ id: profile.id, name: 'Email' }];
sc.getProfile = async () => profile;
sc.getEnrichedAuthorizations = async () => [{ authorizationId: 'a1', bounds: { send_daily_max: 5, recipient_max: 3, read_access: 'unlimited' } }];
sc.getMyReceiptsPage = async () => ({ receipts: [{ id: 't1', authorizationId: 'a1', profileId: profile.id, actionType: 'send', action: 'mail__send_message', timestamp: now - 600, executionContext: {}, cumulativeState: { daily: { count: 3, amount: 0 }, monthly: { count: 9, amount: 0 } } }], nextBefore: null });
const manifests: any[] = [{ id: 'mail', profile: 'email', limitWords: withWords ? { send_daily_max: { noun: 'emails', pastParticiple: 'sent' } } : undefined }];
sc.getLabelManifests = async () => manifests;
sc.getIntegrationManifests = async () => ({ manifests, builtins: [] });
const proposal: any = {
  id: 'p-8c21', authorizationId: 'a1', profileId: profile.id, tool: 'mail__send_message', status: 'refused',
  createdAt: now - 900, expiresAt: now + 3600, executionContext: { action_type: 'send' },
  toolArgs: { to: 'hello@example.com', subject: 'Follow-up after our call' },
  refusal: full
    ? { code: 'CUMULATIVE_LIMIT_EXCEEDED', message: 'Cumulative daily count (6) exceeds send_daily_max=5', at: now - 300, field: 'send_daily_max', expected: 5, actual: 6 }
    : { code: 'CUMULATIVE_LIMIT_EXCEEDED', message: 'Cumulative daily count (6) exceeds send_daily_max=5', at: now - 300 },
};
const item: any = { kind: 'proposal', id: proposal.id, sortTimestamp: proposal.createdAt, commitmentMode: 'review', profileId: profile.id, proposal };
const h = (t: string) => <h2 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-muted)', margin: '24px 0 8px' }}>{t}</h2>;
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <div style={{ maxWidth: 680, margin: '0 auto', padding: 16, background: 'var(--bg-main)', color: 'var(--text-primary)', minHeight: '100vh' }}>
      {h('Approval result after a refusal (card in the Approvals list)')}
      <ActionCard item={item} currentUserId="u1" manifests={manifests} />
      {h('Tickets list')}
      <section className="ticket-day is-today"><div className="ticket-day-head"><span>Today</span></div><div className="ob-list"><div className="ob-list-item"><NoTicketRow proposal={proposal} manifests={manifests} /></div></div></section>
      {h('Mandate form')}
      <div className="card" style={{ padding: 16 }}><BoundsEditor profile={profile} onConfirm={() => {}} /></div>
      {h('Approval card (shared-limit row)')}
      <div className="card av3-card" style={{padding:16,overflow:"visible"}}><div className="av3-body"><SharedLimitRows authorizationId="a1" bounds={{ send_daily_max: 5, recipient_max: 3 }} profile={profile} actionType="send" /></div></div>
    </div>
  </MemoryRouter>,
);
