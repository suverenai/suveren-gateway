import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { TopNav } from '../components/TopNav';
import { useAuth } from '../contexts/AuthContext';
import { spClient, type JoinPreview, type PersonalEndingPreview, type PersonalMandateSummary } from '../lib/sp-client';
import { shouldRestoreWaitingState, shouldLeaveOnboardingForTeam, declinedGroupName, type OnboardingScreen } from '../lib/onboarding-view';

/**
 * Join / create a team — work-plan "Added 2026-10-11 — an account is
 * Personal OR in one team" (mockup v3, sections 1 and 1b). Joining or
 * creating a team MOVES the account: its Personal mandates end (revoked,
 * kept as history) and its pending Personal proposals end too. Join is now
 * a REQUEST the team admin confirms or declines — the invite code alone no
 * longer makes anyone a member.
 *
 * UI shows backend truth only: the waiting state is restored from
 * `pendingRequest` (AuthContext.refreshGroups → GET /api/groups/me), not
 * local state that could drift from what the admin actually did.
 */

function pluralMandates(n: number): string {
  return `${n} personal mandate${n === 1 ? '' : 's'}`;
}

function MandateEndingList({ mandates, pendingProposals }: { mandates: PersonalMandateSummary[]; pendingProposals: number }) {
  if (mandates.length === 0 && pendingProposals === 0) {
    return <p style={{ fontSize: '0.825rem', color: 'var(--text-secondary)' }}>You have no personal mandates to end.</p>;
  }
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: '0.5rem', padding: '0.75rem 1rem', margin: '0.75rem 0' }}>
      <div style={{ fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>
        Your personal mandates end
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.825rem' }}>
        {mandates.map(m => (
          <li key={m.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', padding: '0.25rem 0', borderBottom: '1px solid var(--border)' }}>
            <span>{m.title || m.profileId}</span>
            <span style={{ color: 'var(--text-tertiary)' }}>{m.commitmentMode ?? ''}</span>
          </li>
        ))}
      </ul>
      <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.5rem', marginBottom: 0 }}>
        They stay in your history; their tickets stay verifiable.
        {pendingProposals > 0 && ` ${pendingProposals} personal proposal${pendingProposals === 1 ? '' : 's'} waiting for approval end${pendingProposals === 1 ? 's' : ''} too.`}
      </p>
    </div>
  );
}

export function OnboardingPage() {
  const { mode, pendingRequest, refreshGroups } = useAuth();
  const navigate = useNavigate();

  const [screen, setScreen] = useState<OnboardingScreen>('choose');
  const [inviteCode, setInviteCode] = useState('');
  const [groupName, setGroupName] = useState('');
  const [joinPreview, setJoinPreview] = useState<JoinPreview | null>(null);
  const [createPreview, setCreatePreview] = useState<PersonalEndingPreview | null>(null);
  const [declinedFor, setDeclinedFor] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Reloading the page restores the waiting state from backend truth
  // (pendingRequest), not anything stored locally.
  const restoredFromPending = useRef(false);
  useEffect(() => {
    if (shouldRestoreWaitingState(pendingRequest, restoredFromPending.current)) {
      restoredFromPending.current = true;
      setScreen('join-waiting');
    }
  }, [pendingRequest]);

  // Account moved into the team while waiting — leave onboarding.
  useEffect(() => {
    if (shouldLeaveOnboardingForTeam(screen, mode)) {
      navigate('/');
    }
  }, [screen, mode, navigate]);

  // pendingRequest disappeared WITHOUT the account moving into a team ⇒
  // the admin declined it (or it was withdrawn from elsewhere, e.g.
  // another device) — tell the person, don't just silently reset.
  const prevPendingGroupName = useRef<string | null>(null);
  useEffect(() => {
    if (pendingRequest) {
      prevPendingGroupName.current = pendingRequest.groupName;
      return;
    }
    const declined = declinedGroupName(screen, mode, pendingRequest, prevPendingGroupName.current);
    if (declined) {
      setDeclinedFor(declined);
      setScreen('join-declined');
      prevPendingGroupName.current = null;
    }
  }, [pendingRequest, screen, mode]);

  // Poll backend truth while waiting — admin confirms/declines on the
  // Authority Server dashboard, not through this gateway.
  useEffect(() => {
    if (screen !== 'join-waiting') return;
    const id = setInterval(() => { void refreshGroups(); }, 5000);
    return () => clearInterval(id);
  }, [screen, refreshGroups]);

  const resetToChoose = useCallback(() => {
    setScreen('choose');
    setError('');
    setJoinPreview(null);
    setCreatePreview(null);
    setInviteCode('');
    setGroupName('');
  }, []);

  const handleLookupInvite = async () => {
    if (!inviteCode.trim()) return;
    setLoading(true);
    setError('');
    try {
      const preview = await spClient.getJoinPreview(inviteCode.trim());
      setJoinPreview(preview);
      setScreen('join-preview');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid or expired invite code');
    } finally {
      setLoading(false);
    }
  };

  const handleAskToJoin = async () => {
    setLoading(true);
    setError('');
    try {
      await spClient.requestToJoinGroup(inviteCode.trim());
      await refreshGroups();
      setScreen('join-waiting');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to join group');
    } finally {
      setLoading(false);
    }
  };

  const handleWithdraw = async () => {
    setLoading(true);
    setError('');
    try {
      await spClient.withdrawJoinRequest();
      await refreshGroups();
      resetToChoose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to withdraw request');
    } finally {
      setLoading(false);
    }
  };

  const openCreate = async () => {
    setScreen('create');
    setError('');
    setLoading(true);
    try {
      const preview = await spClient.getCreatePreview();
      setCreatePreview(preview);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load preview');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!groupName.trim()) return;
    setLoading(true);
    setError('');
    try {
      await spClient.createGroup(groupName.trim());
      await refreshGroups();
      navigate('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create group');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <TopNav />
      <div className="main-content no-sidebar" style={{ marginTop: 'var(--nav-height)' }}>
        <div style={{ maxWidth: '30rem', margin: '3rem auto', padding: '0 1rem' }}>

          {error && <div className="error-message">{error}</div>}

          {screen === 'choose' && (
            <>
              <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
                <h2 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Join or create a team</h2>
                <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  An account is Personal or in one team — never both. Joining or creating a team moves your
                  account: your personal mandates end (kept in your history).
                </p>
              </div>

              <div className="card" style={{ marginBottom: '1rem' }}>
                <h4 style={{ fontSize: '0.95rem', marginBottom: '0.25rem' }}>Join an existing team</h4>
                <p style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                  Ask your team admin for an invite code.
                </p>
                <div className="invite-input-row">
                  <input
                    className="form-input"
                    placeholder="Paste invite code..."
                    value={inviteCode}
                    onChange={e => setInviteCode(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleLookupInvite()}
                    style={{ fontFamily: "'SF Mono', Monaco, monospace", fontSize: '0.85rem' }}
                    disabled={loading}
                  />
                  <button className="btn btn-primary" onClick={handleLookupInvite} disabled={loading || !inviteCode.trim()}>
                    {loading ? 'Checking…' : 'Continue'}
                  </button>
                </div>
              </div>

              <div className="card">
                <h4 style={{ fontSize: '0.95rem', marginBottom: '0.25rem' }}>Create a new team</h4>
                <p style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                  Start a new team and invite members.
                </p>
                <button className="btn btn-secondary" onClick={openCreate} disabled={loading}>Create a team</button>
              </div>
            </>
          )}

          {screen === 'join-preview' && joinPreview && (
            <div className="card">
              <h3 style={{ marginBottom: '0.25rem' }}>Join team {joinPreview.groupName}?</h3>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                Your account <strong>moves to the team</strong>. From then on you work under the team's rules
                — its approvers and limits.
              </p>
              <MandateEndingList mandates={joinPreview.personalMandates} pendingProposals={joinPreview.pendingPersonalProposals} />
              <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '1rem' }}>
                The team admin ({joinPreview.admin.name}) confirms your request. Nothing changes until then.
              </p>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button className="btn btn-primary" onClick={handleAskToJoin} disabled={loading}>
                  {loading ? 'Asking…' : 'Ask to join'}
                </button>
                <button className="btn btn-ghost" onClick={resetToChoose} disabled={loading}>Cancel</button>
              </div>
            </div>
          )}

          {screen === 'join-waiting' && (
            <div className="card">
              <h3 style={{ marginBottom: '0.25rem' }}>
                Request sent to team {pendingRequest?.groupName ?? ''}
              </h3>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                Waiting for the team admin to confirm. Until then your account stays Personal and your
                mandates keep working.
              </p>
              <button className="btn btn-secondary" onClick={handleWithdraw} disabled={loading}>
                {loading ? 'Withdrawing…' : 'Withdraw request'}
              </button>
            </div>
          )}

          {screen === 'join-declined' && (
            <div className="card">
              <h3 style={{ marginBottom: '0.25rem' }}>Request to {declinedFor} ended</h3>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                The team admin declined your request, or it was withdrawn. Your account stays Personal.
              </p>
              <button className="btn btn-primary" onClick={resetToChoose} disabled={loading}>Back</button>
            </div>
          )}

          {screen === 'create' && (
            <div className="card">
              <h3 style={{ marginBottom: '0.75rem' }}>Create a team</h3>
              <div className="form-group" style={{ marginBottom: '0.75rem' }}>
                <label style={{ fontSize: '0.825rem', display: 'block', marginBottom: '0.375rem' }}>Team name</label>
                <input
                  className="form-input"
                  placeholder="e.g., Acme Corp"
                  value={groupName}
                  onChange={e => setGroupName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreate()}
                  disabled={loading}
                  autoFocus
                />
              </div>
              {createPreview && (
                <div className="alert alert-info" style={{ color: 'white' }}>
                  Your account moves to the new team. Your {pluralMandates(createPreview.personalMandates.length)} end
                  (kept in your history).
                </div>
              )}
              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
                <button className="btn btn-primary" onClick={handleCreate} disabled={loading || !groupName.trim()}>
                  {loading ? 'Creating…' : 'Create team and move my account'}
                </button>
                <button className="btn btn-ghost" onClick={resetToChoose} disabled={loading}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
