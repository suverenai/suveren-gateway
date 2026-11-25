import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  spClient,
  type ProfileSummary,
  type IntegrationManifest,
  type McpIntegrationStatus,
  type ProfileConfig,
  type BuiltinStatus,
  effectiveGrantors,
} from '../lib/sp-client';
import { pickerEntries, findPreselectedEntry } from '../lib/picker-entries';
import { isTeamAdmin, mandateRight } from '../lib/mandate-rights';
import { profileDisplayName } from '@suveren/approval-card/lib/profile-display';
import { profileIdentity } from '@suveren/approval-card/lib/profile-identity';
import { ProfileIcon } from './ProfileIcon';
import { useAreaCatalog } from '@suveren/approval-card/lib/area-catalog';
import { useSpUrl, teamSettingsHref, ENABLE_IN_TEAM_SETTINGS } from '../lib/use-sp-url';
import { SkelCard } from '@suveren/approval-card/components/LoadGate';

interface Props {
  onDismiss?: () => void;
  /**
   * Skip the grid and go straight into Scope & Limits for this profile — e.g.
   * the dashboard's first-run card linking to its one Delegation mandate
   * instead of making the person find "Delegation" among every connector.
   * Matched by short id (`delegation`) so the caller doesn't need to track
   * which profile version is current. Silently falls back to the normal grid
   * if the profile isn't found, isn't ready yet, or the person can't give it
   * here — never a dead redirect.
   */
  preselectProfileId?: string | null;
}

/**
 * Profile picker that kicks off the gate wizard. Extracted from the old
 * standalone AgentNewPage so it can be embedded in a modal on the
 * Authorizations page — the two used to be separate routes but are really
 * two halves of managing agent authority.
 */
export function AuthorizePicker({ onDismiss, preselectProfileId }: Props) {
  // Loads the connector manifests' area icons (lib/area.ts) and re-renders once they are known.
  useAreaCatalog();
  const navigate = useNavigate();
  const { group, groupId, domain, user, activeMembership, activeTeam } = useAuth();
  const spUrl = useSpUrl();
  const enableHref = teamSettingsHref(spUrl, groupId);
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
  const rightFor = (profile: ProfileSummary) => {
    const config = teamProfiles[profile.id];
    return mandateRight({
      isPersonal: !!group?.isPersonal,
      configLoaded: !loading,
      // TR5 — who may GRANT, not who may approve above cap.
      grantors: config ? effectiveGrantors(config) : undefined,
      userId: user?.id,
      profileName: profileDisplayName(profile.id),
      teamName: group?.name,
      isAdmin: isTeamAdmin(activeTeam, activeMembership, user?.id),
      olderEnabledVersion: olderEnabledVersion(profile.id),
    });
  };

  // The newest older version of this profile the team has enabled (a team takes a new version only after an admin copies the
  // settings, DEC-105), so the card can say exactly that.
  const olderEnabledVersion = (profileId: string): string | null => {
    const at = profileId.lastIndexOf('@');
    if (at < 0) return null;
    const base = profileId.slice(0, at + 1);
    const mine = profileId.slice(at + 1);
    const older = Object.entries(teamProfiles)
      .filter(([id, c]) => id.startsWith(base) && id !== profileId && (() => { const g = effectiveGrantors(c); return g === 'all' || (g?.length ?? 0) > 0; })())
      .map(([id]) => id.slice(at + 1))
      .filter((v) => v.localeCompare(mine, undefined, { numeric: true }) < 0)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return older[0] ?? null;
  };

  const isTeamManaged = (profileId: string): boolean => profileId in teamProfiles;

  // Straight into Scope & Limits. The manifest "Quick start" templates used
  // to be offered here first; they confused more than they helped and were
  // dropped from the flow (2026-09-22). Templates stay in the manifests for
  // the Copy/Edit prefill path only.
  const storeAuthAndNavigate = (profileId: string, intentHint?: string) => {
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
      // The AS's own discriminator (attest gates approvers on !group.isPersonal).
      // groupId is NOT a team signal — the personal workspace has one too.
      isPersonal: !!group?.isPersonal,
      // The integration's starter text for the intent — the mandate screen seeds it.
      ...(intentHint ? { intentHint } : {}),
    }));
    sessionStorage.removeItem('agentGate');
    onDismiss?.();
    navigate('/mandates/new/intent');
  };

  const handleCreate = (profileId: string, intentHint?: string) => {
    if (!groupId) return;
    storeAuthAndNavigate(profileId, intentHint);
  };

  // Preselect: once the grid's data has loaded, skip straight to Scope &
  // Limits for the requested profile (see findPreselectedEntry — matching,
  // readiness and the team approver rule are all checked there). Guarded so
  // it fires at most once.
  const autoNavigated = useRef(false);
  useEffect(() => {
    if (loading || !preselectProfileId || autoNavigated.current) return;
    const match = findPreselectedEntry(entries, preselectProfileId, (e) => rightFor(e.profile).can);
    if (!match) return;
    autoNavigated.current = true;
    handleCreate(match.profile.id, match.intentHint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, preselectProfileId]);

  return (
    <>
      <style>{`
        .profile-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.25rem; align-items: stretch; }
        .profile-grid .card { display: flex; flex-direction: column; height: 100%; margin-top: 0 !important; }
        @media (max-width: 900px) { .profile-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 560px) { .profile-grid { grid-template-columns: 1fr; } }
      `}</style>

      {loading ? (
        // DEC-98: the grid of areas greyed out at the real card size until the profiles are in.
        <div className="profile-grid" data-testid="picker-skeleton" role="status" aria-busy="true" aria-label="Loading">
          {[0, 1, 2, 3, 4, 5].map(i => <SkelCard key={i} lines={2} minHeight="11rem" />)}
        </div>
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
            const { icon } = profileIdentity(p.id, { name: p.name });

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
                    {right.adminCanEnable && enableHref && (
                      <a className="btn btn-secondary btn-sm" style={{ marginTop: '0.5rem', textDecoration: 'none' }} href={enableHref} target="_blank" rel="noopener noreferrer" data-testid="enable-in-team-settings">
                        {ENABLE_IN_TEAM_SETTINGS}
                      </a>
                    )}
                  </>
                ) : entry.ready ? (
                  <button className="btn btn-primary btn-sm" onClick={() => handleCreate(p.id, entry.intentHint)}>
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
