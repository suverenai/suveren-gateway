import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { spClient } from '../lib/sp-client';
import { computeBoundsHashBrowser, computeContextHashBrowser, hashGateContent } from '../lib/frame';
import { StepIndicator } from '../components/StepIndicator';
import { DomainBadge } from '../components/DomainBadge';
import { profileDisplayName } from '../lib/profile-display';
import type { AgentProfile, AgentBoundsParams, AgentContextParams } from '@hap/core';
import type { ProfileConfig } from '../lib/sp-client';

interface GateData {
  bounds: AgentBoundsParams;
  context: AgentContextParams;
  gateContent: { intent: string };
}

interface AuthData {
  profileId: string;
  // v0.4: every attestation requires a group_id. AgentNewPage always sets
  // this to the user's active group (personal or team).
  groupId: string;
  groupName?: string;
  domain: string;
  isTeam?: boolean;
}

export function AgentReviewPage() {
  const navigate = useNavigate();
  const { user, mode, domain: authDomain } = useAuth();
  const [authData, setAuthData] = useState<AuthData | null>(null);
  const [gateData, setGateData] = useState<GateData | null>(null);
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [commitMode, setCommitMode] = useState<'immediate' | 'per-action'>('immediate');
  const [ttlSeconds, setTtlSeconds] = useState(1800);
  const [ttlMax, setTtlMax] = useState(86400);
  const [customTtl, setCustomTtl] = useState('');
  const [customTtlUnit, setCustomTtlUnit] = useState<'hours' | 'days'>('hours');
  const [authTitle, setAuthTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<{ frameHash: string; status: string; commitment: string } | null>(null);
  // Profile-config + resolved approver display names — surfaced as a Review row
  // so the creator sees who the authority is being shared with before signing.
  const [profileConfig, setProfileConfig] = useState<ProfileConfig | null>(null);
  const [approverNames, setApproverNames] = useState<string[]>([]);
  // Track whether the profile-config fetch has completed so the Approvers
  // row can distinguish "loading" from "no approvers configured".
  const [profileConfigLoaded, setProfileConfigLoaded] = useState(false);

  useEffect(() => {
    const authStored = sessionStorage.getItem('agentAuth');
    const gateStored = sessionStorage.getItem('agentGate');
    if (!authStored || !gateStored) { navigate('/agent/new'); return; }

    const auth: AuthData = JSON.parse(authStored);
    const gate = JSON.parse(gateStored);

    const normalizedGate: GateData = {
      bounds: gate.bounds ?? {},
      context: gate.context ?? {},
      gateContent: gate.gateContent,
    };

    setAuthData(auth);
    setGateData(normalizedGate);

    // Set TTL from profile config
    if (gate.ttlConfig) {
      setTtlSeconds(gate.ttlConfig.default ?? 1800);
      setTtlMax(gate.ttlConfig.max ?? 86400);
    }

    spClient.getProfile(auth.profileId)
      .then(p => {
        setProfile(p);

        // Auto-generate title from profile name + context scope
        if (!authTitle) {
          const shortName = p.name ?? auth.profileId.split('/').pop()?.replace(/@.*$/, '') ?? '';
          const contextParts: string[] = [];
          if (normalizedGate.context && p.contextSchema) {
            for (const key of p.contextSchema.keyOrder) {
              const val = normalizedGate.context[key];
              if (val !== undefined && val !== '') {
                const values = String(val).split(',').map(s => s.trim()).filter(Boolean);
                contextParts.push(values.join(', '));
              }
            }
          }
          const title = contextParts.length > 0
            ? `${shortName}: ${contextParts.join(' · ')}`
            : shortName;
          setAuthTitle(title);
        }
      })
      .catch(() => {});

    // Resolve profile-config + approver display names for the Review surface.
    // Mirrors GateWizardPage so the creator sees the same people named both
    // when they author the intent and when they sign.
    if (auth.groupId) {
      Promise.all([
        spClient.getTeamProfileConfig(auth.groupId, auth.profileId).catch(() => null),
        spClient.getGroupById(auth.groupId).catch(() => null),
        spClient.listUsers().catch(() => []),
      ]).then(([config, groupData, users]) => {
        setProfileConfig(config);
        if (config) {
          // Build a userId → display string map. Prefer enriched per-group
          // members (works on freshly-deployed SP), fall back to the global
          // user list (works on older SP deployments — same data, looser
          // privacy scope, but already public via /api/users).
          const map = new Map<string, string>();
          for (const u of users) {
            const label = u.name && u.email ? `${u.name} (${u.email})` : (u.name || u.email || u.id);
            map.set(u.id, label);
          }
          const groupMembers =
            (groupData as { members?: Array<{ userId?: string; id?: string; name?: string; email?: string }> })?.members ?? [];
          for (const m of groupMembers) {
            const id = m.userId ?? m.id;
            if (!id) continue;
            if (m.name && m.email) map.set(id, `${m.name} (${m.email})`);
            else if (m.name) map.set(id, m.name);
            // else leave whatever listUsers gave us
          }
          const names = (config.approvers ?? []).map(id => map.get(id) ?? id);
          setApproverNames(names);
        }
      }).finally(() => {
        setProfileConfigLoaded(true);
      });
    } else {
      // Personal mode — no profile-config concept; mark loaded so UI can
      // render the "no approvers" state without spinning.
      setProfileConfigLoaded(true);
    }
  }, [navigate]);

  const handleCommit = async () => {
    if (!authData || !gateData || !profile || !user) return;
    if (!authData.groupId) {
      setError('No active group; cannot create authorization.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      // P4.6: domains are no longer a per-member primitive. Personal groups
      // sign with 'owner'; team groups sign with the caller's userId. Trust
      // the live AuthContext value over a possibly-stale sessionStorage one.
      const domain = authDomain || authData.domain || 'owner';

      const boundsHash = await computeBoundsHashBrowser(gateData.bounds, profile);
      const contextHash = await computeContextHashBrowser(gateData.context, profile);

      const [intentHashValue, ecHash] = await Promise.all([
        hashGateContent(gateData.gateContent.intent),
        hashGateContent(JSON.stringify({
          profile: authData.profileId,
          domain,
          group: authData.groupId,
        })),
      ]);

      // Phase 5 — Eager intent encryption.
      // Fetch approver pubkeys eagerly (encrypt even
      // within-cap when the profile has approvers, to handle "cap tightened later").
      // If empty array returned, skip encryption.
      let intentCiphertext: string | undefined;
      let encryptedKeys: Record<string, { ct: string; enc: string }> | undefined;
      let approversFrozen: string[] | undefined;

      if (authData.isTeam) {
        const approverPubkeys = await spClient.getApproversPubkeys(
          authData.groupId,
          authData.profileId,
        );
        if (approverPubkeys.length > 0) {
          const encData = await spClient.encryptIntent(
            gateData.gateContent.intent,
            approverPubkeys,
          );
          intentCiphertext = encData.intentCiphertext;
          encryptedKeys = encData.encryptedKeys;
          approversFrozen = encData.approversFrozen;
        }
      }

      // Attest (creates the attestation on SP).
      // v0.4: commitment_mode is part of the signed payload. 'review' means
      // each action requires per-action human approval via a proposal;
      // 'automatic' lets the agent act within bounds without per-action review.
      const result = await spClient.attest({
        profile_id: authData.profileId,
        bounds: gateData.bounds,
        bounds_hash: boundsHash,
        context_hash: contextHash,
        domain,
        did: user.did,
        gate_content_hashes: { intent: intentHashValue },
        execution_context_hash: ecHash,
        group_id: authData.groupId,
        ttl: ttlSeconds,
        commitment_mode: commitMode === 'per-action' ? 'review' : 'automatic',
        title: authTitle.trim(),
        // Phase 5 — E2EE intent fields (undefined when no approvers)
        intent_ciphertext: intentCiphertext,
        encrypted_keys: encryptedKeys,
        approvers_frozen: approversFrozen,
      });

      // Push gate content + context to MCP server (after attestation exists on SP).
      // frame_hash is the SP storage key (per-user); use it for all downstream
      // SP lookups. bounds_hash is the content fingerprint — same across users.
      const storageHash = result.frame_hash ?? result.bounds_hash ?? boundsHash;
      try {
        await spClient.pushGateContent({
          frameHash: storageHash,
          boundsHash,
          contextHash,
          context: gateData.context,
          gateContent: gateData.gateContent,
        });
      } catch (pushErr) {
        // Gate content push failed — revoke the attestation so it doesn't orphan
        try {
          await spClient.revokeAttestation(attestationHash, 'Auto-revoked: gate content push failed');
        } catch { /* best effort */ }
        throw new Error(`Authorization signed but gate content delivery failed. The attestation was revoked. Please try again. (${pushErr instanceof Error ? pushErr.message : 'Unknown error'})`);
      }

      setSuccess({
        frameHash: attestationHash,
        status: result.status,
        commitment: commitMode === 'per-action' ? 'per-action' : 'immediate',
      });
      sessionStorage.removeItem('agentAuth');
      sessionStorage.removeItem('agentGate');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Attestation failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (!authData || !gateData) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading...</p>;
  }

  if (success) {
    return (
      <div className="success-card">
        <div className="success-card-title">Authorization Created</div>
        <div className="success-card-hash">{success.frameHash}</div>
        <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          Status: <strong>{success.status}</strong>
          {success.commitment === 'per-action' && (
            <div style={{ marginTop: '0.5rem' }}>
              Commitment: <strong>Review Mode</strong> — you will review and commit to each agent action individually.
            </div>
          )}
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/')}>
          Back to Dashboard
        </button>
      </div>
    );
  }

  const boundsEntries = Object.entries(gateData.bounds).filter(([k]) => k !== 'profile' && k !== 'path');
  const contextEntries = Object.entries(gateData.context);

  // Pre-compute display strings — keeps all string interpolation out of JSX
  // expression positions to stay clear of edge cases in the esbuild TSX parser.
  const capKeys = profileConfig?.caps != null ? Object.keys(profileConfig.caps) : [];
  const hasCaps = capKeys.length !== 0;
  const approverNamesStr = approverNames.length > 0
    ? approverNames.join(', ')
    : (profileConfig?.approvers ?? []).join(', ');
  const approversSubLine = hasCaps
    ? `Within-cap actions run per the mode you choose above. Over-cap actions will require approval from you and ${approverNamesStr}, regardless of your mode.`
    : `No caps set — they won't gate any action, but your intent is encrypted and shared with them as an accountability record.`;
  const bottomNote = hasCaps
    ? `Over-cap actions will be reviewed by you and ${approverNamesStr}. Within-cap actions run per the mode you chose above.`
    : `Approvers ${approverNamesStr} can read your intent but won't gate any action — no caps configured on this profile.`;
  const showBottomNote = !!(profileConfig?.approvers?.length);
  const ttlExceedsMax = ttlSeconds > ttlMax;
  const commitStyleImmediate = {
    flex: 1,
    padding: '0.75rem',
    border: commitMode === 'immediate' ? '2px solid var(--accent)' : '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    background: commitMode === 'immediate' ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
    cursor: 'pointer' as const,
    textAlign: 'left' as const,
    fontFamily: 'inherit',
  };
  const commitStylePerAction = {
    flex: 1,
    padding: '0.75rem',
    border: commitMode === 'per-action' ? '2px solid var(--accent)' : '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    background: commitMode === 'per-action' ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
    cursor: 'pointer' as const,
    textAlign: 'left' as const,
    fontFamily: 'inherit',
  };

  return (
    <>
      <StepIndicator currentStep={4} onStepClick={s => {
        if (s <= 3) navigate(`/agent/gate?step=${s}`);
      }} />

      <div className="card">
        <h3 className="card-title" style={{ marginBottom: '0.25rem' }}>Review &amp; Commit</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
          Review your authorization details before signing.
        </p>

        {error && <div className="error-message">{error}</div>}

        <dl className="review-grid">
          <dt>Profile</dt>
          <dd>
            {profileDisplayName(authData.profileId)}
            <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.125rem' }}>{authData.profileId}</div>
          </dd>
          {authData.groupName && (
            <>
              <dt>Team</dt>
              <dd>{authData.groupName}</dd>
            </>
          )}
          {/* Approvers row — always visible in team mode so the creator
              knows whether anyone else can read their intent. Hidden only
              for personal-mode (groupId absent) where it's never relevant. */}
          {authData.groupId && (
            <>
              <dt>Approvers</dt>
              <dd>
                {!profileConfigLoaded ? (
                  <span style={{ color: 'var(--text-tertiary)' }}>Loading…</span>
                ) : (profileConfig?.approvers?.length ?? 0) === 0 ? (
                  <>
                    <span style={{ color: 'var(--text-tertiary)' }}>None &mdash; solo authorization</span>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.125rem' }}>
                      No approvers configured for this profile in this team. Your intent stays on your gateway.
                    </div>
                  </>
                ) : (
                  <>
                    {approverNamesStr}
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.125rem' }}>
                      {approversSubLine}
                    </div>
                  </>
                )}
              </dd>
            </>
          )}
          <dt>TTL</dt>
          <dd>30 minutes</dd>
        </dl>

        {!!boundsEntries.length && (
          <>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: '1rem', marginBottom: '0.25rem' }}>
              Bounds
            </div>
            <dl className="review-grid">
              {boundsEntries.map(([k, v]) => (
                <span key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd>{String(v)}</dd>
                </span>
              ))}
            </dl>
          </>
        )}

        {!!contextEntries.length && (
          <>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: '1rem', marginBottom: '0.25rem' }}>
              Context
            </div>
            <dl className="review-grid">
              {contextEntries.map(([k, v]) => (
                <span key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd>{String(v)}</dd>
                </span>
              ))}
            </dl>
          </>
        )}

        <div className="gate-content-block">
          <div className="gate-content-item">
            <div className="gate-content-label">Intent</div>
            <div className="gate-content-text">{gateData.gateContent.intent}</div>
          </div>
        </div>

        {/* Commitment mode selection */}
        <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: '1rem', marginBottom: '0.5rem' }}>
          Commitment
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem' }}>
          <button onClick={() => setCommitMode('immediate')} style={commitStyleImmediate}>
            <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--text-primary)' }}>Automatic</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Agent acts freely within your limits.
            </div>
          </button>
          <button onClick={() => setCommitMode('per-action')} style={commitStylePerAction}>
            <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--text-primary)' }}>Review Each Action</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              You review and approve each action before it executes.
            </div>
          </button>
        </div>

        {/* Duration selector */}
        <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.5rem' }}>
          Duration
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.25rem', alignItems: 'center' }}>
          {[
            { label: '1 hour', seconds: 3600 },
            { label: '24 hours', seconds: 86400 },
            { label: '7 days', seconds: 604800 },
            { label: '30 days', seconds: 2592000 },
            { label: '1 year', seconds: 31536000 },
          ].filter(p => p.seconds <= ttlMax).map(preset => (
            <button
              key={preset.seconds}
              onClick={() => { setTtlSeconds(preset.seconds); setCustomTtl(''); }}
              style={{
                padding: '0.5rem 0.85rem',
                border: ttlSeconds === preset.seconds ? '2px solid var(--accent)' : '1px solid var(--border)',
                borderRadius: '0.375rem',
                background: ttlSeconds === preset.seconds ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                cursor: 'pointer', fontSize: '0.85rem', fontFamily: 'inherit',
                color: 'var(--text-primary)',
              }}
            >
              {preset.label}
            </button>
          ))}
          <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
            <input
              type="number"
              className="form-input"
              style={{ width: '5rem', padding: '0.45rem 0.6rem', fontSize: '0.85rem' }}
              placeholder="Custom"
              value={customTtl}
              onChange={e => {
                setCustomTtl(e.target.value);
                const num = parseInt(e.target.value, 10);
                if (num > 0) {
                  const secs = customTtlUnit === 'days' ? num * 86400 : num * 3600;
                  setTtlSeconds(Math.min(secs, ttlMax));
                }
              }}
            />
            <select
              className="form-input"
              style={{ padding: '0.45rem 0.5rem', fontSize: '0.85rem' }}
              value={customTtlUnit}
              onChange={e => {
                setCustomTtlUnit(e.target.value as 'hours' | 'days');
                const num = parseInt(customTtl, 10);
                if (num > 0) {
                  const secs = e.target.value === 'days' ? num * 86400 : num * 3600;
                  setTtlSeconds(Math.min(secs, ttlMax));
                }
              }}
            >
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </div>
          {ttlExceedsMax && (
            <span style={{ fontSize: '0.75rem', color: 'var(--danger)' }}>
              Maximum: {ttlMax >= 86400 ? `${Math.floor(ttlMax / 86400)} days` : `${Math.floor(ttlMax / 3600)} hours`}
            </span>
          )}
        </div>

        {/* Title */}
        <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.5rem' }}>
          Title
        </div>
        <div style={{ marginBottom: '1.25rem' }}>
          <input
            type="text"
            className="form-input"
            placeholder={`e.g. ${profileDisplayName(authData.profileId)}: daily operations`}
            value={authTitle}
            onChange={e => setAuthTitle(e.target.value)}
            maxLength={80}
            style={{ fontSize: '0.9rem' }}
          />
          <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
            A short name to identify this authorization on your dashboard.
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-ghost" onClick={() => navigate('/agent/gate')}>Back</button>
          <button
            className="btn btn-primary btn-lg"
            style={{ flex: 1 }}
            onClick={handleCommit}
            disabled={submitting || !authTitle.trim()}
          >
            {submitting ? 'Signing...' : commitMode === 'immediate' ? 'Authorize' : 'Authorize (Review Mode)'}
          </button>
        </div>

        <div style={{ marginTop: '1rem', fontSize: '0.75rem', color: 'var(--text-tertiary)', textAlign: 'center', display: showBottomNote ? 'block' : 'none' }}>
          {bottomNote}
        </div>
      </div>
    </>
  );
}
