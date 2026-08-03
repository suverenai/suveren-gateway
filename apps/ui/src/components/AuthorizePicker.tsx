import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  spClient,
  type ProfileSummary,
  type IntegrationManifest,
  type McpIntegrationStatus,
  type AuthTemplate,
  type ProfileConfig,
} from '../lib/sp-client';

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
  const { group, groupId, domain } = useAuth();
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [manifests, setManifests] = useState<IntegrationManifest[]>([]);
  const [integrations, setIntegrations] = useState<McpIntegrationStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [teamProfiles, setTeamProfiles] = useState<Record<string, ProfileConfig>>({});
  const [modalProfile, setModalProfile] = useState<{ profileId: string; manifest: IntegrationManifest } | null>(null);

  useEffect(() => {
    Promise.all([
      spClient.listProfiles().catch(() => []),
      spClient.getIntegrationManifests().then(d => d.manifests ?? []).catch(() => []),
      spClient.getMcpHealth().then(h => h.integrations ?? []).catch(() => []),
    ]).then(async ([profileList, manifestList, integrationList]) => {
      setProfiles(profileList);
      setManifests(manifestList);
      setIntegrations(integrationList);

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

  // Which profiles have an installed connector at all. Only used to filter the
  // profile list below; the integration itself is resolved per entry, because a
  // profile-keyed integration map cannot represent two connectors sharing one
  // profile — the defect this component was fixed for.
  const profileManifestMap = new Map<string, IntegrationManifest>();
  for (const m of manifests) {
    if (m.profile) profileManifestMap.set(m.profile, m);
  }

  // Only profiles an installed manifest maps to, deduped to the HIGHEST version
  // per short id. Several versions of one profile can be served at once (e.g.
  // customers@0.4 kept for old grants + customers@0.5 with a read gate); the
  // picker must offer exactly one — the newest — or the same integration lists
  // twice. New grants are created under the newest version.
  const shortOf = (id: string): string => id.replace(/@.*$/, '').split('/').pop() ?? id;
  const versionOf = (id: string): string => id.split('@')[1] ?? '';
  const latestByShort = new Map<string, ProfileSummary>();
  for (const p of profiles) {
    const shortId = shortOf(p.id);
    if (!profileManifestMap.has(shortId)) continue;
    const existing = latestByShort.get(shortId);
    // Numeric-aware compare so 0.10 > 0.9; falls back to localeCompare.
    if (!existing || versionOf(p.id).localeCompare(versionOf(existing.id), undefined, { numeric: true }) > 0) {
      latestByShort.set(shortId, p);
    }
  }

  /**
   * One entry per INSTALLED INTEGRATION, not per profile.
   *
   * This list used to be keyed by profile, which silently lost integrations:
   * several connectors legitimately share one profile — a deploy profile serves
   * a GitHub/Vercel connector and a Kubernetes one, an email profile would serve
   * Gmail and Outlook — and a profile-keyed map keeps only whichever was
   * processed last. The user saw a single card, named after the profile, with no
   * way to tell which connector they were authorising.
   *
   * Keying by integration also lets the card say "Deploy (GitHub)" rather than
   * "Deploy", which is the name the person actually recognises.
   */
  const entries = manifests
    .map(manifest => {
      const profile = manifest.profile ? latestByShort.get(manifest.profile) : undefined;
      return profile ? { manifest, profile, integration: integrations.find(i => i.id === manifest.id) } : null;
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const isTeamManaged = (profileId: string): boolean => profileId in teamProfiles;

  const storeAuthAndNavigate = (profileId: string, template?: AuthTemplate) => {
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
    }));
    if (template) {
      sessionStorage.setItem('agentGate', JSON.stringify({
        bounds: template.bounds,
        context: template.context,
        gateContent: { intent: template.intent },
        ttlConfig: { max: template.ttl },
        templateMode: template.mode,
        templateTtl: template.ttl,
      }));
    } else {
      sessionStorage.removeItem('agentGate');
    }
    setModalProfile(null);
    onDismiss?.();
    navigate('/agent/gate');
  };

  // Takes the manifest directly. Resolving it from the profile id would hit the
  // same collision the entry list exists to avoid: two connectors, one profile,
  // and a lookup that can only return one of them.
  const handleCreate = (profileId: string, manifest: IntegrationManifest) => {
    if (!groupId) return;

    if (manifest?.templates && manifest.templates.length > 0) {
      setModalProfile({ profileId, manifest });
    } else {
      storeAuthAndNavigate(profileId);
    }
  };

  // Step 2 — template picker for a selected profile. Rendered inline in the
  // same modal so the flow is Profile → Template without stacked modals.
  if (modalProfile) {
    const tpls = modalProfile.manifest.templates ?? [];
    return (
      <>
        <button
          className="btn btn-ghost btn-sm"
          style={{ marginBottom: '1rem' }}
          onClick={() => setModalProfile(null)}
        >
          &larr; Back to profiles
        </button>

        <h3 style={{ margin: '0 0 0.25rem 0', fontSize: '1rem' }}>
          Set up {modalProfile.manifest.name} authorization
        </h3>

        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem', marginBottom: '0.75rem', fontWeight: 600 }}>
          Quick start
        </p>
        <div style={{
          display: 'grid',
          gap: '0.75rem',
          gridTemplateColumns: `repeat(${Math.min(tpls.length, 3)}, 1fr)`,
        }}>
          {tpls.map((tpl) => (
            <button
              key={tpl.name}
              className="template-card"
              onClick={() => storeAuthAndNavigate(modalProfile.profileId, tpl)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
                <span className={`template-mode template-mode-${tpl.mode === 'automatic' ? 'auto' : 'review'}`}>
                  {tpl.mode === 'automatic' ? 'Auto' : 'Review'}
                </span>
                <span className="template-risk" data-risk={tpl.risk}>{tpl.risk}</span>
              </div>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
                {tpl.name}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.45, marginBottom: '0.5rem' }}>
                {tpl.description}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                {tpl.tags.map(tag => (
                  <span key={tag} className="template-tag">{tag}</span>
                ))}
              </div>
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', margin: '1.5rem 0' }}>
          <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
          <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>or</span>
          <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
        </div>

        <button
          className="btn btn-primary"
          style={{ width: '100%', textAlign: 'center', padding: '0.75rem' }}
          onClick={() => storeAuthAndNavigate(modalProfile.profileId)}
        >
          Custom — define your own limits and scope
        </button>
      </>
    );
  }

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
          {entries.map(({ manifest, profile: p, integration }) => {
            const isTeam = isTeamManaged(p.id);
            const isRunning = integration?.running === true;

            return (
              <div className="card" key={manifest.id} style={!isRunning ? { opacity: 0.7 } : undefined}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.125rem' }}>
                  {/* The INTEGRATION's name — "Deploy (GitHub)", not "Deploy".
                      Several connectors can share one profile, so the profile
                      name cannot identify what is being authorised. */}
                  <h3 className="card-title" style={{ margin: 0 }}>
                    {manifest.name}
                  </h3>
                  {isTeam ? (
                    <span style={{
                      fontSize: '0.6rem', padding: '0.1rem 0.35rem', borderRadius: '0.2rem',
                      background: 'var(--accent-subtle)', color: 'var(--accent)', fontWeight: 600,
                    }}>Team</span>
                  ) : (
                    <span style={{
                      fontSize: '0.6rem', padding: '0.1rem 0.35rem', borderRadius: '0.2rem',
                      background: 'var(--bg-main)', color: 'var(--text-tertiary)', fontWeight: 600,
                      border: '1px solid var(--border)',
                    }}>Personal</span>
                  )}
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '1rem', flex: 1 }}>
                  {manifest.description || p.description}
                </p>

                {isRunning ? (
                  <button className="btn btn-primary btn-sm" onClick={() => handleCreate(p.id, manifest)}>
                    Authorize
                  </button>
                ) : (
                  <Link
                    to={`/integrations?setup=${manifest?.id ?? ''}`}
                    className="btn btn-secondary btn-sm"
                    style={{ textDecoration: 'none', textAlign: 'center' }}
                    onClick={() => onDismiss?.()}
                  >
                    Set up {manifest?.name ?? 'integration'}
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
