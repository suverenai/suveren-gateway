import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { spClient } from '../lib/sp-client';

interface GroupDetail {
  id: string;
  name: string;
  members: Array<{
    id: string;
    name: string;
    email: string;
    domains: string[];
    role: string;
    isAdmin: boolean;
  }>;
}

/**
 * Read-only team context surface in the gateway. Team CRUD (create / join /
 * invite / member admin / profile-config) lives on the Service Provider
 * dashboard. The gateway shows the user's current team membership and a
 * Leave action — nothing else. Linking out keeps the gateway focused on
 * agent operations.
 */
export function GroupsPage() {
  const { activeTeam, activeMembership, refreshGroups, user } = useAuth();
  const [groupDetail, setGroupDetail] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [spUrl, setSpUrl] = useState('');

  // Fetch SP base URL once so we can build "Manage in your Service Provider" links.
  useEffect(() => {
    fetch('/health').then(r => r.json()).then(data => {
      if (typeof data.spUrl === 'string') setSpUrl(data.spUrl);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!activeTeam) { setGroupDetail(null); return; }
    spClient.getGroupById(activeTeam.id)
      .then(raw => {
        // SP returns { group, members, isAdmin } — normalize it
        const g = (raw as { group?: { id: string; name: string; createdBy?: string } }).group
          ?? (raw as unknown as { id: string; name: string; createdBy?: string });
        const rawMembers = (raw as { members?: Array<Record<string, unknown>> }).members ?? [];
        const isAdminFromSP = (raw as { isAdmin?: boolean }).isAdmin ?? false;
        const members = rawMembers.map(m => {
          const userId = (m.userId as string) || (m.id as string) || '';
          const role = (m.role as string) || (isAdminFromSP && userId === g.createdBy ? 'admin' : 'member');
          return {
            id: userId,
            name: (m.name as string) || userId.slice(0, 8) || 'Member',
            email: (m.email as string) || '',
            domains: (m.domains as string[]) || [],
            role,
            isAdmin: role === 'admin' || (isAdminFromSP && userId === g.createdBy),
          };
        });
        setGroupDetail({ id: g.id, name: g.name, members });
      })
      .catch(() => setGroupDetail(null));
  }, [activeTeam?.id]);

  // Sole admin: cannot leave until admin is transferred (or team is deleted)
  // on the SP dashboard. We keep this gate in the gateway so users who land
  // here directly aren't allowed into a flow that will 409 server-side.
  const adminMembers = groupDetail?.members.filter(m => m.isAdmin) ?? [];
  const isSoleAdmin =
    activeTeam?.isAdmin === true &&
    adminMembers.length <= 1 &&
    adminMembers.some(m => m.id === user?.id);

  const teamName = activeTeam?.name ?? '';
  const confirmReady = confirmText.trim() === teamName && !loading;

  const openLeaveModal = () => {
    setConfirmText('');
    setShowLeaveConfirm(true);
  };

  const closeLeaveModal = () => {
    setShowLeaveConfirm(false);
    setConfirmText('');
  };

  const handleLeave = async () => {
    if (!activeTeam || !confirmReady) return;
    setLoading(true);
    setError('');
    try {
      await spClient.leaveTeam(activeTeam.id);
      await refreshGroups();
      setSuccessMsg('You have left the team.');
      setGroupDetail(null);
      closeLeaveModal();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to leave team');
    } finally {
      setLoading(false);
    }
  };

  // Build SP dashboard URLs. We point at the SP's existing /dashboard/groups
  // surface; the SP owns team CRUD now.
  const manageHref = activeTeam && spUrl ? `${spUrl}/dashboard/groups/${activeTeam.id}` : undefined;
  const browseTeamsHref = spUrl ? `${spUrl}/dashboard/groups` : undefined;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Team</h1>
          <p className="page-subtitle">
            Your current team context. Team management lives in your Authority Server dashboard.
          </p>
        </div>
      </div>

      {error && <div className="error-message">{error}</div>}
      {successMsg && <div className="alert alert-success">{successMsg}</div>}

      {activeTeam ? (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <div className="card-header">
            <div>
              <h3 className="card-title">{activeTeam.name}</h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginTop: '0.125rem' }}>
                {groupDetail?.members?.length ?? 0} {(groupDetail?.members?.length ?? 0) === 1 ? 'member' : 'members'}
                {activeTeam.isAdmin && ' · You are admin'}
              </p>
            </div>
            <span className="status-badge status-active">Active</span>
          </div>

          {groupDetail?.members?.map(member => (
            <div className="member-row" key={member.id}>
              <div className="member-avatar">
                {member.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
              </div>
              <div className="member-info">
                <div className="member-name">{member.name}</div>
                <div className="member-email">{member.email}</div>
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{member.role}</span>
            </div>
          ))}

          <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            {manageHref && (
              <a
                className="btn btn-secondary btn-sm"
                href={manageHref}
                target="_blank"
                rel="noopener noreferrer"
              >
                Manage this team in your Authority Server &rarr;
              </a>
            )}
            <span title={isSoleAdmin ? 'You are the only admin. Transfer admin to another member in your Authority Server dashboard before leaving.' : undefined} style={{ marginLeft: 'auto' }}>
              <button
                className="btn btn-ghost btn-sm"
                style={{ color: 'var(--text-tertiary)' }}
                onClick={openLeaveModal}
                disabled={loading || isSoleAdmin}
              >
                Leave team
              </button>
            </span>
          </div>
        </div>
      ) : (
        <div className="card" style={{ textAlign: 'center', padding: '2rem 1.5rem' }}>
          <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem' }}>You are working solo.</h3>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem', maxWidth: 480, marginLeft: 'auto', marginRight: 'auto' }}>
            Every mandate you create here is in your personal context. You can join an existing
            team or create a new one in your Authority Server dashboard.
          </p>
          {browseTeamsHref && (
            <a
              className="btn btn-primary btn-sm"
              href={browseTeamsHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Authority Server dashboard &rarr;
            </a>
          )}
        </div>
      )}

      {showLeaveConfirm && activeTeam && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="leave-team-title"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1rem',
          }}
          onClick={closeLeaveModal}
        >
          <div
            className="card"
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: 480, width: '100%', margin: 0 }}
          >
            <h3 id="leave-team-title" className="card-title" style={{ marginBottom: '0.5rem' }}>
              Leave {teamName}?
            </h3>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
              Leaving will:
            </p>
            <ul style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem', paddingLeft: '1.25rem', lineHeight: 1.6 }}>
              <li>Revoke all mandates you created in this team's context</li>
              <li>Reject any pending action proposals you authored</li>
              <li>Disable your membership — rejoining requires admin reactivation</li>
            </ul>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
              Your <strong>personal</strong> mandates are not affected.
            </p>
            <div className="form-group">
              <label htmlFor="leave-confirm-input" style={{ fontSize: '0.825rem', display: 'block', marginBottom: '0.375rem' }}>
                Type <code>{teamName}</code> to confirm:
              </label>
              <input
                id="leave-confirm-input"
                className="form-input"
                type="text"
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder={teamName}
                disabled={loading}
                autoFocus
              />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button
                className="btn btn-ghost"
                onClick={closeLeaveModal}
                disabled={loading}
              >
                Cancel
              </button>
              <button
                className="btn btn-secondary"
                style={{ color: 'var(--danger, #e53e3e)' }}
                onClick={handleLeave}
                disabled={!confirmReady}
              >
                {loading ? 'Leaving...' : 'Leave team'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
