import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { spClient } from '../lib/sp-client';
import { ObTypeLine, ObFold, useFoldAccordion } from '../components/ObjectCard';

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
  const navigate = useNavigate();
  const accordion = useFoldAccordion<HTMLElement>();
  const [groupDetail, setGroupDetail] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
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

  const handleLeave = async () => {
    if (!activeTeam || !confirmReady) return;
    setLoading(true);
    setError('');
    try {
      await spClient.leaveTeam(activeTeam.id);
      await refreshGroups();
      setSuccessMsg('You have left the team.');
      setGroupDetail(null);
      setConfirmText('');
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

  const memberCount = groupDetail?.members?.length ?? 0;

  return (
    <div className="su-page">
      <div className="page-header">
        <h1 className="page-title">Team</h1>
        <p className="page-subtitle">
          Your current team context. Team management lives in your Authority Server dashboard.
        </p>
      </div>

      {error && <div className="error-message">{error}</div>}
      {successMsg && <div className="alert alert-success">{successMsg}</div>}

      {activeTeam ? (
        <article className="ob-card su-card" ref={accordion}>
          <ObTypeLine
            tag="TEAM"
            parts={[
              <span className="ob-st">Active</span>,
              `${memberCount} ${memberCount === 1 ? 'member' : 'members'}`,
            ]}
          />
          <h2 className="ob-title is-h3">{activeTeam.name}</h2>

          {memberCount > 0 && (
            <section className="ob-tile su-members">
              <div className="su-tile-h">Members</div>
              {groupDetail?.members.map(member => (
                <div className="su-m" key={member.id}>
                  <span className="su-av">
                    {member.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                  </span>
                  <div className="su-who">
                    <b>{member.name}</b>
                    <span>{member.email}</span>
                  </div>
                  <span className={`su-role${member.isAdmin ? ' is-admin' : ''}`}>{member.role}</span>
                </div>
              ))}
            </section>
          )}

          <ObFold
            title="Leave team"
            summary={isSoleAdmin ? 'you are the only admin' : 'revokes your mandates in this team'}
          >
            <p>Leaving will:</p>
            <ul className="su-list">
              <li>Revoke all mandates you created in this team's context</li>
              <li>Reject any pending action proposals you authored</li>
              <li>Disable your membership — rejoining requires admin reactivation</li>
            </ul>
            <p className="ob-lbl ob-gap">Your personal mandates are not affected.</p>
            {isSoleAdmin ? (
              <p className="ob-lbl">
                You are the only admin. Transfer admin to another member in your Authority Server
                dashboard before leaving.
              </p>
            ) : (
              <>
                <div className="form-group">
                  <label htmlFor="leave-confirm-input" className="form-label">
                    Type <code>{teamName}</code> to confirm
                  </label>
                  <input
                    id="leave-confirm-input"
                    className="form-input"
                    type="text"
                    value={confirmText}
                    onChange={e => setConfirmText(e.target.value)}
                    placeholder={teamName}
                    disabled={loading}
                  />
                </div>
                <div className="ob-btns is-inline is-tight">
                  <button className="ob-btn" onClick={handleLeave} disabled={!confirmReady}>
                    {loading ? 'Leaving...' : 'Leave team'}
                  </button>
                </div>
              </>
            )}
          </ObFold>

          {manageHref && (
            <div className="ob-btns">
              <a className="ob-btn" href={manageHref} target="_blank" rel="noopener noreferrer">
                Manage this team in your Authority Server &#8599;
              </a>
            </div>
          )}
        </article>
      ) : (
        <article className="ob-card su-card">
          <ObTypeLine tag="TEAM" parts={[<span className="ob-st">Personal</span>]} />
          <h2 className="ob-title is-h3">You are working solo.</h2>
          <p className="ob-one">
            Every mandate you create here is in your personal context. An account is Personal or in
            one team — joining or creating a team moves it.
          </p>
          <div className="ob-btns">
            <button className="ob-btn is-solid" onClick={() => navigate('/onboarding')}>
              Join or create a team
            </button>
            {browseTeamsHref && (
              <a className="ob-btn" href={browseTeamsHref} target="_blank" rel="noopener noreferrer">
                Manage teams in your Authority Server &#8599;
              </a>
            )}
          </div>
        </article>
      )}
    </div>
  );
}
