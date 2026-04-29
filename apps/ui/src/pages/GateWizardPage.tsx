import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { spClient, type ProfileConfig } from '../lib/sp-client';
import { StepIndicator } from '../components/StepIndicator';
import { ContextStrip } from '../components/ContextStrip';
import { BoundsEditor } from '../components/BoundsEditor';
import { AIChatPanel } from '../components/AIChatPanel';
import type { AgentProfile, AgentBoundsParams, AgentContextParams } from '@hap/core';

interface AuthData {
  profileId: string;
  groupId?: string;
  groupName?: string;
  domain: string;
}

export function GateWizardPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialStep = Number(searchParams.get('step')) || 2;
  const [authData, setAuthData] = useState<AuthData | null>(null);
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [step, setStep] = useState(initialStep); // 2=scope+limits, 3=intent
  const [bounds, setBounds] = useState<AgentBoundsParams | null>(null);
  const [context, setContext] = useState<AgentContextParams | null>(null);
  const [intent, setIntent] = useState('');
  const [loading, setLoading] = useState(true);
  // Team profile config — null when not in team mode or no config set
  const [profileConfig, setProfileConfig] = useState<ProfileConfig | null>(null);
  // Resolved display names for approver userIds
  const [approverNames, setApproverNames] = useState<string[]>([]);
  // Display name of the team admin
  const [adminName, setAdminName] = useState<string | undefined>(undefined);

  useEffect(() => {
    const stored = sessionStorage.getItem('agentAuth');
    if (!stored) { navigate('/agent/new'); return; }
    const data: AuthData = JSON.parse(stored);
    setAuthData(data);

    // Restore previous selections if user navigated back
    const gateStored = sessionStorage.getItem('agentGate');
    if (gateStored) {
      const gate = JSON.parse(gateStored);
      if (gate.bounds) setBounds(gate.bounds);
      if (gate.context) setContext(gate.context);
      if (gate.gateContent?.intent) setIntent(gate.gateContent.intent);
    }

    spClient.getProfile(data.profileId)
      .then(p => setProfile(p))
      .catch(() => navigate('/agent/new'))
      .finally(() => setLoading(false));

    // Fetch team profile config when in team mode
    if (data.groupId) {
      Promise.all([
        spClient.getTeamProfileConfig(data.groupId, data.profileId).catch(() => null),
        spClient.getGroupById(data.groupId).catch(() => null),
        spClient.listUsers().catch(() => []),
      ]).then(([config, groupData, users]) => {
        setProfileConfig(config);
        if (config) {
          // Layered name resolution: enriched group members first (when SP
          // is freshly deployed), global users list fallback (works on
          // older SP deployments).
          const map = new Map<string, string>();
          for (const u of users) {
            const label = u.name && u.email ? `${u.name} (${u.email})` : (u.name || u.email || u.id);
            map.set(u.id, label);
          }
          const groupMembers =
            (groupData as { members?: Array<{ userId?: string; id?: string; name?: string; email?: string; role?: string }> })?.members ?? [];
          for (const m of groupMembers) {
            const id = m.userId ?? m.id;
            if (!id) continue;
            if (m.name && m.email) map.set(id, `${m.name} (${m.email})`);
            else if (m.name) map.set(id, m.name);
          }
          const names = (config.approvers ?? []).map(id => map.get(id) ?? id);
          setApproverNames(names);
          // Admin display name — used by the hard-ceiling footer in BoundsEditor.
          const adminEntry = groupMembers.find(m => m.role === 'admin');
          if (adminEntry) {
            const adminId = adminEntry.userId ?? adminEntry.id;
            if (adminId) setAdminName(map.get(adminId) ?? adminEntry.name);
          }
        }
      });
    }
  }, [navigate]);

  const boundsString = bounds
    ? Object.entries(bounds)
        .filter(([k]) => k !== 'profile' && k !== 'path')
        .map(([k, v]) => `${k} = ${v}`)
        .join(', ')
    : '';

  const handleBoundsConfirm = (b: AgentBoundsParams, c: AgentContextParams) => {
    setBounds(b);
    setContext(c);

    // Suggest intent from selected scope + bounds
    if (!intent.trim() && profile) {
      const parts: string[] = [];

      // Context fields (scope)
      const contextSchema = profile.contextSchema;
      if (contextSchema) {
        for (const key of contextSchema.keyOrder) {
          const val = c[key];
          if (val !== undefined && val !== '') {
            const field = contextSchema.fields[key];
            const label = field?.displayName ?? key.replace(/_/g, ' ');
            const values = String(val).split(',').map(s => s.trim()).filter(Boolean);
            parts.push(`${label}: ${values.join(', ')}`);
          }
        }
      }

      // Bounds fields (limits)
      const boundsSchema = profile.boundsSchema ?? profile.frameSchema;
      if (boundsSchema) {
        for (const key of boundsSchema.keyOrder) {
          if (key === 'profile' || key === 'path') continue;
          const val = b[key];
          if (val !== undefined && val !== '' && val !== 0) {
            const field = boundsSchema.fields[key];
            const label = field?.displayName ?? key.replace(/_/g, ' ');
            parts.push(`${label}: ${val}`);
          }
        }
      }

      if (parts.length > 0) {
        setIntent(parts.join('. ') + '.');
      }
    }

    setStep(3);
  };

  const handleIntentNext = () => {
    const ttlConfig = profile?.ttl;
    const gateContent = { intent };
    sessionStorage.setItem('agentGate', JSON.stringify({ bounds, context, gateContent, ttlConfig }));
    navigate('/agent/review');
  };

  if (loading || !authData || !profile) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading...</p>;
  }

  return (
    <>
      <StepIndicator currentStep={step} onStepClick={s => { if (s >= 2) setStep(s); }} />

      {/* Context strip */}
      <ContextStrip
        profileId={authData.profileId}
        bounds={boundsString || undefined}
        groupName={authData.groupName}
        domain={authData.domain}
      />

      {/* Step 2: Bounds */}
      {step === 2 && (
        <div className="card">
          <BoundsEditor
            profile={profile}
            onConfirm={handleBoundsConfirm}
            onCancel={() => navigate('/agent/new')}
            initialBounds={bounds || undefined}
            initialContext={context || undefined}
            profileConfig={profileConfig}
            approverNames={approverNames}
            adminName={adminName}
          />
        </div>
      )}

      {/* Step 3: Intent */}
      {step === 3 && (
        <div className="card">
          <h3 className="card-title" style={{ marginBottom: '0.25rem' }}>What should your agent know?</h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            Help your agent understand your intent. Consider:
          </p>
          <ul style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem', paddingLeft: '1.25rem', lineHeight: 1.7 }}>
            <li><strong>Why</strong> — What's the situation? Why does this need to happen?</li>
            <li><strong>Goal</strong> — What should the agent try to achieve?</li>
            <li><strong>Watch out</strong> — What should the agent avoid or be careful about?</li>
          </ul>

          {/* Intent-encryption notice — shown whenever the profile has approvers configured.
              Names the approvers explicitly so the creator knows exactly who can read this. */}
          {(profileConfig?.approvers?.length ?? 0) > 0 && (
            <div style={{
              padding: '0.75rem 0.875rem',
              border: '1px solid var(--accent)',
              borderRadius: '0.375rem',
              background: 'var(--bg-elevated)',
              fontSize: '0.82rem',
              marginBottom: '0.75rem',
              lineHeight: 1.55,
            }}>
              <div style={{ fontWeight: 600, color: 'var(--accent)', marginBottom: '0.25rem' }}>
                Visible to {approverNames.length > 0 ? approverNames.join(', ') : 'the configured approvers'}
              </div>
              Your intent will be encrypted and shared with{' '}
              {approverNames.length > 0 ? approverNames.join(', ') : 'this profile\'s required approvers'}.
              Only they can decrypt it &mdash; your Service Provider cannot.
              Each approver stores a copy as their accountability record.
            </div>
          )}

          <div className="form-group" style={{ marginBottom: '0.5rem' }}>
            <textarea
              className="form-textarea"
              placeholder="e.g. We're running a spring promotion. Process customer refunds up to $50. Don't refund orders older than 30 days. Flag anything that looks unusual."
              value={intent}
              onChange={e => setIntent(e.target.value)}
              style={{ minHeight: '160px' }}
            />
          </div>
          <div className="char-counter">
            {intent.length} / 2000
          </div>

          {/* AI chat — multi-turn refinement of this auth's Intent. */}
          <div style={{ marginTop: '0.75rem' }}>
            <AIChatPanel
              target={{
                kind: 'intent',
                profileId: authData.profileId,
                bounds: boundsString || undefined,
              }}
              currentText={intent}
              onApply={(text) => {
                if (intent.trim() && !confirm('Replace the current intent with the applied draft?')) return;
                setIntent(text);
              }}
              title="Refine with AI — intent"
            />
            <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
              Advisory only — AI surfaces reality, you supply intent.
            </div>
          </div>

          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn-ghost" onClick={() => setStep(2)}>Back</button>
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={handleIntentNext}
              disabled={!intent.trim()}
            >
              Continue to Review
            </button>
          </div>
        </div>
      )}
    </>
  );
}
