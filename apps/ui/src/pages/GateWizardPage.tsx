import { useState, useEffect, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { spClient, type ProfileConfig } from '../lib/sp-client';
import { StepIndicator } from '../components/StepIndicator';
import { ContextStrip } from '../components/ContextStrip';
import { BoundsEditor } from '../components/BoundsEditor';
import { AssistantChatPanel } from '../components/AssistantChatPanel';
import { BottomSheet } from '../components/BottomSheet';
import { profileDisplayName } from '../lib/profile-display';
import { resolveAdvisoryLinks, type AdvisoryGrant } from '../lib/advisory-links';
import type { AgentProfile, AgentBoundsParams, AgentContextParams } from '@hap/core';

/** Initial textarea content for the Intent step. The user replaces
 *  these prompt lines with their own words; the Continue button stays
 *  disabled until the text differs from this template. */
const INTENT_TEMPLATE = `Why — What's the situation? Why does this need to happen?

Goal — What should the agent try to achieve?

Watch out — What should the agent avoid or be careful about?`;

interface AuthData {
  profileId: string;
  groupId?: string;
  groupName?: string;
  domain: string;
}

/** A grant the intent cross-check compared against (for the clickable popup). */
type ComparedGrant = AdvisoryGrant;

/** Render advisory text with clickable references to the grants it compared.
 *  The resolution (which text becomes which link) is pure and unit-tested in
 *  advisory-links.ts; here we only map the resolved segments to React nodes. */
function renderAdvisory(
  text: string,
  grants: ComparedGrant[],
  onOpen: (matched: ComparedGrant[]) => void,
  profileLabel: string,
): ReactNode {
  return resolveAdvisoryLinks(text, grants, profileLabel).map((seg, i) => {
    if (!seg.matched) return <span key={i}>{seg.text}</span>;
    const list = seg.matched;
    return (
      <button
        key={i}
        type="button"
        onClick={() => onOpen(list)}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          color: 'var(--accent)', textDecoration: 'underline', font: 'inherit',
        }}
      >
        {seg.label}
      </button>
    );
  });
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
  const [intent, setIntent] = useState(INTENT_TEMPLATE);
  const [chatOpenMobile, setChatOpenMobile] = useState(false);
  const [loading, setLoading] = useState(true);
  // Team profile config — null when not in team mode or no config set
  const [profileConfig, setProfileConfig] = useState<ProfileConfig | null>(null);
  // Resolved display names for approver userIds
  const [approverNames, setApproverNames] = useState<string[]>([]);
  // Display name of the team admin
  const [adminName, setAdminName] = useState<string | undefined>(undefined);
  // On-demand intent cross-check (Phase 2) — advisory result vs existing grants
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewResult, setReviewResult] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewGrants, setReviewGrants] = useState<ComparedGrant[]>([]);
  const [popupGrants, setPopupGrants] = useState<ComparedGrant[] | null>(null);

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
    setStep(3);
  };

  /** True when the textarea has been edited away from the template
   *  (and is non-empty). Gates the Continue button. */
  const intentChanged =
    intent.trim() !== INTENT_TEMPLATE.trim() && intent.trim() !== '';

  const handleApplyDraft = (text: string) => {
    if (intentChanged && !confirm('Replace your current intent with the AI draft?')) return;
    setIntent(text);
  };

  const handleIntentNext = () => {
    const ttlConfig = profile?.ttl;
    const gateContent = { intent };
    sessionStorage.setItem('agentGate', JSON.stringify({ bounds, context, gateContent, ttlConfig }));
    navigate('/agent/review');
  };

  const handleCheckIntent = async () => {
    if (!authData) return;
    setReviewLoading(true);
    setReviewResult(null);
    setReviewNote(null);
    setReviewError(null);
    setReviewGrants([]);
    setPopupGrants(null);
    try {
      const r = await spClient.aiIntentReview({
        profileId: authData.profileId,
        newIntent: intent,
        context: context ?? undefined,
      });
      setReviewGrants(r.grants ?? []);
      if (!r.success) setReviewError(r.error ?? 'Check failed.');
      else if (r.review) setReviewResult(r.review);
      else setReviewNote(r.note ?? 'No other authorizations on this profile to compare against.');
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : 'Check failed.');
    } finally {
      setReviewLoading(false);
    }
  };

  // Editing the intent invalidates a prior review.
  const handleIntentChange = (text: string) => {
    setIntent(text);
    if (reviewResult || reviewNote || reviewError) {
      setReviewResult(null);
      setReviewNote(null);
      setReviewError(null);
      setReviewGrants([]);
      setPopupGrants(null);
    }
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
        <div className="intent-layout">
          {/* LEFT — AI chat (hidden on ≤768px; reachable via floating button + bottom sheet) */}
          <div className="card intent-pane chat">
            <AssistantChatPanel
              target={{
                kind: 'intent',
                profileId: authData.profileId,
                bounds: boundsString || undefined,
              }}
              currentText={intent}
              onApply={handleApplyDraft}
            />
          </div>

          {/* RIGHT — the document, the centerpiece */}
          <div className="card intent-pane document">
            <h3 className="card-title">What should your agent know?</h3>

            <textarea
              className="intent-textarea"
              value={intent}
              onChange={e => handleIntentChange(e.target.value)}
            />

            <div className="char-counter">{intent.length} / 2000</div>

            {/* On-demand semantic cross-check against existing grants (Phase 2) */}
            <div style={{ marginTop: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem' }}
                onClick={handleCheckIntent}
                disabled={reviewLoading || !intentChanged}
              >
                {reviewLoading ? 'Checking…' : 'Check against my other grants'}
              </button>

              {reviewError && (
                <div className="hint-box" role="note" style={{ marginTop: '0.5rem', borderLeftColor: 'var(--danger)' }}>
                  <span className="hint-icon" aria-hidden="true">!</span>
                  <div className="hint-body">{reviewError}</div>
                </div>
              )}
              {reviewNote && (
                <div className="hint-box" role="note" style={{ marginTop: '0.5rem' }}>
                  <span className="hint-icon" aria-hidden="true">i</span>
                  <div className="hint-body">{reviewNote}</div>
                </div>
              )}
              {reviewResult && (
                <div className="hint-box" role="note" style={{ marginTop: '0.5rem' }}>
                  <span className="hint-icon" aria-hidden="true">i</span>
                  <div className="hint-body">
                    <div className="hint-head">Intent review (advisory)</div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{renderAdvisory(reviewResult, reviewGrants, setPopupGrants, profileDisplayName(authData.profileId))}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginTop: '0.4rem' }}>
                      Checked with your configured assistant. AI surfaces reality — you decide.
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="intent-footer">
              <button className="btn btn-ghost" onClick={() => setStep(2)}>Back</button>
              <button
                className="btn btn-primary intent-continue-btn"
                onClick={handleIntentNext}
                disabled={!intentChanged}
              >
                Continue to Review
              </button>
            </div>

            {/* Encryption notice — informational hint box below the action */}
            {(profileConfig?.approvers?.length ?? 0) > 0 && (
              <div className="hint-box" role="note">
                <span className="hint-icon" aria-hidden="true">i</span>
                <div className="hint-body">
                  <div className="hint-head">
                    Visible to {approverNames.length > 0 ? approverNames.join(', ') : 'the configured approvers'}
                  </div>
                  Your intent will be encrypted and shared with{' '}
                  {approverNames.length > 0 ? approverNames.join(', ') : 'this profile\'s required approvers'}.
                  Only they can decrypt it &mdash; your Service Provider cannot.
                  Each approver stores a copy as their accountability record.
                </div>
              </div>
            )}
          </div>

          {/* Mobile-only floating help button + bottom sheet */}
          <button
            type="button"
            className="floating-help"
            onClick={() => setChatOpenMobile(true)}
            aria-label="Open intent assistant"
          >
            Get help with intent
          </button>

          <BottomSheet
            open={chatOpenMobile}
            onClose={() => setChatOpenMobile(false)}
            ariaLabel="Intent assistant"
          >
            <AssistantChatPanel
              target={{
                kind: 'intent',
                profileId: authData.profileId,
                bounds: boundsString || undefined,
              }}
              currentText={intent}
              onApply={(text) => {
                handleApplyDraft(text);
                setChatOpenMobile(false);
              }}
            />
          </BottomSheet>

          {/* Popup: the existing authorization(s) the advisory refers to. A
              scope can match more than one grant (scope is not unique), so we
              show every match rather than guessing one. */}
          {popupGrants && (
            <div
              className="modal-backdrop"
              onClick={e => e.target === e.currentTarget && setPopupGrants(null)}
            >
              <div className="modal">
                <div className="modal-header">
                  <h3 className="modal-title">
                    {popupGrants.length > 1
                      ? `Existing authorizations (${popupGrants.length})`
                      : 'Existing authorization'}
                  </h3>
                  <button className="modal-close" onClick={() => setPopupGrants(null)}>&times;</button>
                </div>
                <div className="modal-body">
                  {popupGrants.map((g, gi) => (
                    <div
                      key={gi}
                      style={{
                        marginBottom: gi < popupGrants.length - 1 ? '1rem' : 0,
                        paddingBottom: gi < popupGrants.length - 1 ? '1rem' : 0,
                        borderBottom: gi < popupGrants.length - 1 ? '1px solid var(--border)' : 'none',
                      }}
                    >
                      <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.25rem' }}>Scope</div>
                      <div style={{ marginBottom: '0.75rem' }}>{g.scope}</div>

                      <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.25rem' }}>Intent</div>
                      <div style={{ whiteSpace: 'pre-wrap', marginBottom: '0.75rem' }}>{g.intent?.trim() || '(no intent recorded)'}</div>

                      {Object.entries(g.bounds).filter(([k]) => k !== 'profile' && k !== 'path').length > 0 && (
                        <>
                          <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.25rem' }}>Limits</div>
                          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            {Object.entries(g.bounds)
                              .filter(([k]) => k !== 'profile' && k !== 'path')
                              .map(([k, v]) => `${k}: ${v}`)
                              .join(' · ')}
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
