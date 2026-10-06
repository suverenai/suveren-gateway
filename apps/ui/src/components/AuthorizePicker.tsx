import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  spClient,
  type ProfileSummary,
  type IntegrationManifest,
  type McpIntegrationStatus,
  type ProfileConfig,
  type BuiltinStatus,
} from '../lib/sp-client';
import { pickerEntries } from '../lib/picker-entries';
import { mandateRight } from '../lib/mandate-rights';
import { profileDisplayName } from '../lib/profile-display';
import { profileIdentity } from '../lib/profile-identity';
import { ProfileIcon } from './ProfileIcon';

interface Props {
  onDismiss?: () => void;
}

/**
 * Profile picker that kicks off the gate wizard. Extracted from the old
 * standalone AgentNewPage so it can be embedded in a modal on the
 * Authorizations page — the two used to be separate routes but are really
 * two halves of managing agent authority.
 */
export function AuthorizePicker({ onDismiss }: Props) {
  const navigate = useNavigate();
  const { group, groupId, domain, user } = useAuth();
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [manifests, setManifests] = useState<IntegrationManifest[]>([]);
  const [integrations, setIntegrations] = useState<McpIntegrationStatus[]>([]);
  const [builtins, setBuiltins] = useState<BuiltinStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [teamProfiles, setTeamProfiles] = useState<Record<string, ProfileConfig>>({});

  useEffect(() => {
    Promise.all([
      spClient.listProfiles().catch(() => []),
      spClient.getIntegrationManifests().then(d => d.manifests ?? []).catch(() => []),
      spClient.getMcpHealth().catch(() => null),
    ]).then(async ([profileList, manifestList, health]) => {
      setProfiles(profileList);
      setManifests(manifestList);
      setIntegrations(health?.integrations ?? []);
      setBuiltins(health?.builtins ?? []);

      // Phase 3: profile-config is per-profile now. Fetch in parallel for
      // the team's profiles so we can show the "Team" badge on managed ones.
      if (groupId) {
        const configs = await Promise.all(
          profileList.map(p =>
            spClient.getTeamProfileConfig(groupId, p.id).catch(() => null),
          ),
        );
        const teamConfigMap: Record<string, ProfileConfig> = {};
        profileList.forEach((p, i) => {
          const c = configs[i];
          if (c) teamConfigMap[p.id] = c;
        });
        setTeamProfiles(teamConfigMap);
      }
    }).finally(() => setLoading(false));
  }, [groupId]);

  // Connectors and the gateway's own tool groups, each with the newest profile
  // version the Authority Server serves (see lib/picker-entries.ts).
  const entries = pickerEntries(profiles, manifests, integrations, builtins);

  // Whether this person may give a mandate for a profile here — the Authority
  // Server's team rule, shown at selection instead of on the last page.
  const rightFor = (profile: ProfileSummary) => mandateRight({
    isPersonal: !!group?.isPersonal,
    configLoaded: !loading,
    approvers: teamProfiles[profile.id]?.approvers,
    userId: user?.id,
    profileName: profileDisplayName(profile.id),
    teamName: group?.name,
  });

  const isTeamManaged = (profileId: string): boolean => profileId in teamProfiles;

  // Straight into Scope & Limits. The manifest "Quick start" templates used
  // to be offered here first; they confused more than they helped and were
  // dropped from the flow (2026-09-22). Templates stay in the manifests for
  // the Copy/Edit prefill path only.
  const storeAuthAndNavigate = (profileId: string) => {
    if (!groupId) {
      console.error('No active group when creating authorization');
      return;
    }
    const isTeam = isTeamManaged(profileId);
    sessionStorage.setItem('agentAuth', JSON.stringify({
      profileId,
      groupId,
      groupName: group?.name ?? null,
      domain,
      isTeam,
      // The AS's own discriminator (attest gates approvers on !group.isPersonal).
      // groupId is NOT a team signal — the personal workspace has one too.
      isPersonal: !!group?.isPersonal,
    }));
    sessionStorage.removeItem('agentGate');
    onDismiss?.();
    navigate('/mandates/new/intent');
  };

  const handleCreate = (profileId: string) => {
    if (!groupId) return;
    storeAuthAndNavigate(profileId);
  };

  return (
    <>
      <style>{`
        .profile-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.25rem; align-items: stretch; }
        .profile-grid .card { display: flex; flex-direction: column; height: 100%; margin-top: 0 !important; }
        @media (max-width: 900px) { .profile-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 560px) { .profile-grid { grid-template-columns: 1fr; } }
      `}</style>

      {loading ? (
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem' }}>Loading...</p>
      ) : entries.length === 0 ? (
        <div className="card" style={{ padding: '2rem', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
            No integrations set up yet. Connect a service first.
          </p>
          <Link to="/integrations" className="btn btn-primary btn-sm" onClick={() => onDismiss?.()}>
            Go to Integrations
          </Link>
        </div>
      ) : (
        <div className="profile-grid">
          {entries.map((entry) => {
            const p = entry.profile;
            const isTeam = isTeamManaged(p.id);
            const right = rightFor(p);
            const muted = !entry.ready || !right.can;
            // Neutral icon (no per-profile color — see lib/profile-identity.ts),
            // declared by the profile JSON when it sets one, else a fallback
            // map keyed by the profile's short id.
            const { icon } = profileIdentity(p.id, { name: p.name, icon: p.icon });

            return (
              <div className="card" key={entry.key} style={muted ? { opacity: 0.7 } : undefined}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.125rem' }}>
                  {/* The INTEGRATION's name — "Deploy (GitHub)", not "Deploy".
                      Several connectors can share one profile, so the profile
                      name cannot identify what is being authorised. */}
                  <h3 className="card-title profile-chip" style={{ margin: 0 }}>
                    <ProfileIcon icon={icon} className="profile-chip-icon" />
                    {entry.name}
                  </h3>
                  {/* "Personal" only in the personal workspace: in a team, an
                      unconfigured profile is not personal — it is not enabled,
                      which the card says below. */}
                  {isTeam ? (
                    <span style={{
                      fontSize: '0.6rem', padding: '0.1rem 0.35rem', borderRadius: '0.2rem',
                      background: 'var(--accent-subtle)', color: 'var(--accent)', fontWeight: 600,
                    }}>Team</span>
                  ) : group?.isPersonal ? (
                    <span style={{
                      fontSize: '0.6rem', padding: '0.1rem 0.35rem', borderRadius: '0.2rem',
                      background: 'var(--bg-main)', color: 'var(--text-tertiary)', fontWeight: 600,
                      border: '1px solid var(--border)',
                    }}>Personal</span>
                  ) : null}
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '1rem', flex: 1 }}>
                  {entry.description}
                </p>

                {!right.can ? (
                  <>
                    <button className="btn btn-secondary btn-sm" disabled>Give a mandate</button>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
                      {right.reason} <span style={{ color: 'var(--text-tertiary)' }}>{right.fix}</span>
                    </div>
                  </>
                ) : entry.ready ? (
                  <button className="btn btn-primary btn-sm" onClick={() => handleCreate(p.id)}>
                    Give a mandate
                  </button>
                ) : entry.kind === 'builtin' ? (
                  <>
                    <button className="btn btn-secondary btn-sm" disabled>Give a mandate</button>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.5rem' }}>
                      {entry.unavailableReason}
                    </div>
                  </>
                ) : (
                  <Link
                    to={`/integrations?setup=${entry.setupId ?? ''}`}
                    className="btn btn-secondary btn-sm"
                    style={{ textDecoration: 'none', textAlign: 'center' }}
                    onClick={() => onDismiss?.()}
                  >
                    Set up {entry.name}
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}

    </>
  );
}
