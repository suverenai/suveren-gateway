import { useState, useEffect } from 'react';
import { LoadGate, Gated, SkelLine, SkelBlock, SkelButton, SkelArea } from '@suveren/approval-card/components/LoadGate';
import { autoTitleUnlessTyped } from '../lib/auto-title';
import { COMMITMENT_LABEL, COMMITMENT_REVIEW, COMMITMENT_AUTOMATIC } from '@suveren/approval-card/lib/commitment-words';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { spClient } from '../lib/sp-client';
import { computeBoundsHashBrowser } from '../lib/frame';
import { StepIndicator } from '../components/StepIndicator';
import { DomainBadge } from '../components/DomainBadge';
import { profileDisplayName } from '@suveren/approval-card/lib/profile-display';
import { offeredCommitModes, settleCommitMode, toProtocolMode } from '../lib/commit-mode';
import { scopesOverlap } from '../lib/scope-overlap';
import { formatScopeFieldValue } from '../lib/scope-labels';
import { useSourceManifests } from '@suveren/approval-card/lib/source-manifests';
import { useSimulationMode } from '../hooks/useSimulationMode';
import { hiddenLimitKeys, type ManifestGatingLike } from '@suveren/approval-card/lib/simulation-only-limits';
import { isTeamAdmin, mandateRight } from '../lib/mandate-rights';
import { replacedRevokeProblem } from '../lib/mandate-replace';
import { replacedOutcomeArgs, replacedWithdrawRoute } from '@suveren/approval-card/lib/reject-outcome';
import { computeMandateDiff, type MandateDiff } from '@hap/core/mandate-change';
import { unmetForMandate, atLeastOneSignHint } from '@hap/core/scope-rules';
import { MandateChangeDiff } from '@suveren/approval-card/components/MandateChangeCard';
import type { AgentProfile, AgentBoundsParams, AgentScopeParams } from '@hap/core';
import { effectiveGrantors, MandateSignError, type ProfileConfig } from '../lib/sp-client';
import { useDeviceChain } from '../lib/use-device-chain';
import {
  S13, GiveApprovers, giveBlocked, approverLines, limitRows, limitValueText, scopeLabel, durationText, endDateText, giveErrorText,
  GivePhoneFooter, giveSummaryLine, GiveTouchFooter,
} from '@suveren/approval-card/mandate-screens';
import { useGive, closeReplacedProposal } from '../lib/use-give';
import { useSpUrl, teamSettingsHref, ENABLE_IN_TEAM_SETTINGS } from '../lib/use-sp-url';

/** An existing active grant under the same profile, with its local scope. */
interface ExistingGrant {
  authorizationId: string;
  bounds: Record<string, string | number>;
  context: AgentScopeParams;
  intent: string | null;
}

interface GateData {
  bounds: AgentBoundsParams;
  context: AgentScopeParams;
  /** Discovered display names per context field (value → label). */
  contextLabels?: Record<string, Record<string, string>>;
  gateContent: { intent: string };
}

interface AuthData {
  profileId: string;
  // v0.4: every attestation requires a group_id. AgentNewPage always sets
  // this to the user's active group (personal or team) — so its presence
  // says nothing about team vs personal. Use `isPersonal` for that.
  groupId: string;
  groupName?: string;
  domain: string;
  /** True when groupId is the auto-provisioned personal workspace — the same
   *  flag the AS uses to skip the approver requirement. Absent in snapshots
   *  written before this flag existed; treated as "team" (the safe side —
   *  it can only block a ceremony the AS would refuse anyway, never unblock). */
  isPersonal?: boolean;
  /** Set by Copy/Edit (AuthorizationsPage.handleCopy) when it moved this
   *  mandate to a newer profile version — the original (pinned) profile id,
   *  shown as a one-line notice below so the person sees the move before
   *  signing. Absent for a brand-new mandate, or when the grant being
   *  copied was already on the newest version. */
  upgradedFromProfileId?: string;
}

export function AgentReviewPage() {
  const navigate = useNavigate();
  const { user, activeMembership, activeTeam } = useAuth();
  const spUrl = useSpUrl();
  // Chain accounts only (device keys on, a set-up device): the review step gives the mandate with Touch ID (DEC-80). Everyone else sees today's page.
  const chain = useDeviceChain();
  const [adminName, setAdminName] = useState('');
  const [approverIds, setApproverIds] = useState<string[]>([]);
  // What the gateway checked (POST /api/mandate/prepare): the plan, the approvers with their confirmation, and any refusal before the touch.
  const [given, setGiven] = useState<{ authorizationId: string; text: string } | null>(null);
  const [authData, setAuthData] = useState<AuthData | null>(null);
  const [gateData, setGateData] = useState<GateData | null>(null);
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [profileFailed, setProfileFailed] = useState(false);
  const sourceManifests = useSourceManifests();
  const simulation = useSimulationMode();
  // Review is the DEFAULT commitment mode: the agent proposes, the human
  // approves. Automatic is the deliberate opt-in (or a template's choice).
  const [commitMode, setCommitMode] = useState<'immediate' | 'per-action'>('per-action');
  // 0 = not chosen yet: the person decides how long, unless a template or an AI proposal already says.
  const [ttlSeconds, setTtlSeconds] = useState(0);
  const [ttlMax, setTtlMax] = useState(86400);
  const [customTtl, setCustomTtl] = useState('');
  const [customTtlUnit, setCustomTtlUnit] = useState<'hours' | 'days'>('hours');
  const [authTitle, setAuthTitle] = useState('');
  // Default ON: "verified by Suveren + your name" only takes effect when the
  // identity is actually verified (otherwise actions stay pseudonymous), so
  // the safe-and-most-useful default is to disclose. Opt-out stays one click.
  const [discloseIdentity, setDiscloseIdentity] = useState(true);
  // The owner's standing choice (Settings): when on, the AS attaches the name
  // whatever this checkbox says, so the checkbox shows it locked on.
  const [alwaysDisclose, setAlwaysDisclose] = useState(false);
  useEffect(() => {
    spClient.getIdentityDisclosure()
      .then(d => setAlwaysDisclose(d.always))
      .catch(() => { /* the AS still applies the standing choice; the box just isn't locked */ });
  }, []);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // Profile-config + resolved approver display names — surfaced as a Review row
  // so the creator sees who the authority is being shared with before signing.
  const [profileConfig, setProfileConfig] = useState<ProfileConfig | null>(null);
  const [approverNames, setApproverNames] = useState<string[]>([]);
  // Track whether the profile-config fetch has completed so the Approvers
  // row can distinguish "loading" from "no approvers configured".
  const [profileConfigLoaded, setProfileConfigLoaded] = useState(false);
  // Structural-overlap warning: existing active grants under the same profile,
  // enriched with their local context (scope) so we can compare scopes. Context
  // stays local (privacy-blind) — read from the local gate store, never the AS.
  const [existingSameProfile, setExistingSameProfile] = useState<ExistingGrant[]>([]);
  // Duplicate-bounds soft warning: count of existing active grants on this
  // profile whose bounds hash exactly matches the one being created. Since
  // identity is per-ceremony, a duplicate is safe (no silent merge) — but the
  // user usually meant to Extend the existing grant, not mint a twin.
  const [duplicateBoundsCount, setDuplicateBoundsCount] = useState(0);

  useEffect(() => {
    const authStored = sessionStorage.getItem('agentAuth');
    const gateStored = sessionStorage.getItem('agentGate');
    if (!authStored || !gateStored) { navigate('/mandates?new=1'); return; }

    const auth: AuthData = JSON.parse(authStored);
    const gate = JSON.parse(gateStored);

    const normalizedGate: GateData = {
      bounds: gate.bounds ?? {},
      context: gate.context ?? {},
      contextLabels: gate.contextLabels ?? undefined,
      gateContent: gate.gateContent,
    };

    setAuthData(auth);
    setGateData(normalizedGate);

    // Set TTL from profile config
    if (gate.ttlConfig) {
      setTtlMax(gate.ttlConfig.max ?? 86400);
    }

    // Commitment mode chosen upstream — by a template (template.mode) or by
    // the grant being copied/edited (its deferred-commitment state). Review
    // is the page default, so only an explicit 'automatic' flips it. Without
    // this read, review-mode templates and edited review grants always landed
    // as "automatic".
    if (gate.templateMode === 'automatic') {
      setCommitMode('immediate');
    } else if (gate.templateMode === 'review') {
      setCommitMode('per-action');
    }

    // Duration chosen upstream — the template's ttl or the copied/edited
    // grant's original lifetime. Clamped to the profile max; reflected in the
    // custom input when it isn't one of the preset buttons.
    const maxTtl = gate.ttlConfig?.max ?? 86400;
    if (typeof gate.templateTtl === 'number' && gate.templateTtl > 0) {
      const secs = Math.min(gate.templateTtl, maxTtl);
      setTtlSeconds(secs);
      const PRESETS = [3600, 86400, 604800, 2592000, 31536000];
      if (!PRESETS.includes(secs)) {
        if (secs % 86400 === 0) {
          setCustomTtl(String(secs / 86400));
          setCustomTtlUnit('days');
        } else {
          setCustomTtl(String(Math.max(1, Math.round(secs / 3600))));
          setCustomTtlUnit('hours');
        }
      }
    }

    spClient.getProfile(auth.profileId)
      .then(p => {
        setProfile(p);

        // Auto-generate title from profile name + context scope
        if (!authTitle) {
          const shortName = p.name ?? auth.profileId.split('/').pop()?.replace(/@.*$/, '') ?? '';
          const contextParts: string[] = [];
          if (normalizedGate.context && p.scopeSchema) {
            for (const key of p.scopeSchema.keyOrder) {
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
          // The profile can arrive after the person typed: never overwrite what they typed (this closure saw the first, empty title).
          setAuthTitle(prev => autoTitleUnlessTyped(prev, title));
        }
      })
      // The review card shows without the profile (as before), never an endless skeleton (DEC-98).
      .catch(() => setProfileFailed(true));

    // Resolve profile-config + approver display names for the Review surface.
    // Mirrors GateWizardPage so the creator sees the same people named both
    // when they author the intent and when they sign.
    if (!auth.isPersonal) {
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
          setApproverIds(config.approvers ?? []);
          const admin = ((groupData as { members?: Array<{ name?: string; email?: string; role?: string }> })?.members ?? []).find(m => m.role === 'admin');
          if (admin) setAdminName(admin.name || admin.email || '');
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

  // Load existing ACTIVE grants under the same profile, with their local scope.
  // Source is the enriched authorizations endpoint — the same active set
  // list-authorizations shows (cache-backed, so no stale gate entries, and each
  // carries its real context). This avoids the fragile join that previously
  // dropped context and made an empty scope read as a wildcard (false overlaps).
  useEffect(() => {
    if (!authData?.profileId) return;
    const profileId = authData.profileId;
    // Edit flow: the grant being replaced must not warn against itself —
    // same bounds/scope as the prefill is the expected starting point.
    const replacesId = sessionStorage.getItem('agentEditReplaces');
    spClient.getEnrichedAuthorizations()
      .then(auths => {
        const grants: ExistingGrant[] = auths
          .filter(a => a.profileId === profileId && a.authorizationId !== replacesId)
          .map(a => ({ authorizationId: a.authorizationId, bounds: a.bounds, context: a.context ?? {}, intent: a.intent }));
        setExistingSameProfile(grants);
      })
      .catch(() => setExistingSameProfile([]));
  }, [authData?.profileId]);

  // Edit / "Change it myself": the differences, recomputed against the signed
  // mandate on every change of the form — what the person is about to sign.
  const [editDiff, setEditDiff] = useState<MandateDiff | null>(null);
  useEffect(() => {
    const replacesId = sessionStorage.getItem('agentEditReplaces');
    if (!replacesId || !profile || !gateData) { setEditDiff(null); return; }
    let cancelled = false;
    spClient.getEnrichedAuthorizations()
      .then(async (auths) => {
        const old = auths.find((a) => a.authorizationId === replacesId);
        if (!old || !old.expiresAt) return;
        const oldProfile = old.profileId === profile.id ? profile : await spClient.getProfile(old.profileId);
        if (cancelled) return;
        const mode = (domains: string[]) => (domains.length > 0 ? 'review' : 'automatic');
        const nowSec = Math.floor(Date.now() / 1000);
        setEditDiff(computeMandateDiff({
          before: { profile: oldProfile, bounds: old.bounds, scope: old.context, intent: old.intent ?? '', mode: mode(old.deferredCommitmentDomains), expiresAt: old.expiresAt },
          after: { profile, bounds: gateData.bounds, scope: gateData.context, intent: gateData.gateContent.intent, mode: toProtocolMode(commitMode), expiresAt: ttlSeconds > 0 ? nowSec + ttlSeconds : old.expiresAt },
        }));
      })
      .catch(() => { if (!cancelled) setEditDiff(null); });
    return () => { cancelled = true; };
  }, [profile, gateData, commitMode, ttlSeconds]);
  const aiIntent = typeof window !== 'undefined' ? sessionStorage.getItem('agentChangeAiIntent') : null;

  // Duplicate-bounds detection: hash the ceremony's bounds and each existing
  // same-profile grant's bounds with the same canonicalization the attest
  // flow uses, then count exact matches. Purely advisory — per-ceremony
  // identity means a twin never merges with the original on the AS.
  // A preset mode (template, edited grant) the profile does not allow falls
  // back to one it does.
  useEffect(() => {
    if (!profile) return;
    const settled = settleCommitMode(commitMode, offeredCommitModes(profile));
    if (settled && settled !== commitMode) setCommitMode(settled);
  }, [profile, commitMode]);

  useEffect(() => {
    if (!gateData || !profile || existingSameProfile.length === 0) {
      setDuplicateBoundsCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      const current = await computeBoundsHashBrowser(gateData.bounds, profile);
      const hashes = await Promise.all(
        existingSameProfile.map(g => computeBoundsHashBrowser(g.bounds, profile).catch(() => null)),
      );
      if (!cancelled) setDuplicateBoundsCount(hashes.filter(h => h === current).length);
    })().catch(() => { if (!cancelled) setDuplicateBoundsCount(0); });
    return () => { cancelled = true; };
  }, [gateData, profile, existingSameProfile]);

  // The request the give would send, as one object: prepared here (chain gateways) and given from here, so they cannot differ.
  const giveRequest = authData && gateData && authData.groupId && authTitle.trim() && ttlSeconds > 0 ? {
    team: authData.isPersonal ? 'personal' : authData.groupId,
    profile: authData.profileId,
    limits: gateData.bounds as Record<string, string | number>,
    scope: gateData.context as Record<string, string | number>,
    contextLabels: gateData.contextLabels,
    intent: gateData.gateContent.intent,
    mode: toProtocolMode(commitMode),
    ttlSeconds,
    title: authTitle.trim(),
    discloseIdentity,
    replaces: sessionStorage.getItem('agentEditReplaces') || undefined,
  } : null;
  // The one give driver (lib/use-give.ts): the same as the approval card's "Give this mandate".
  const fromProposal = sessionStorage.getItem('agentReplacesProposal') || undefined;
  const driver = useGive(chain ? giveRequest : null, { chain, fromProposal, userId: user?.id ?? '' });
  const { prepared, prepareError, touchView, phoneGive } = driver;
  const setPrepareTick = (_: unknown) => driver.recheck();
  const unconfirmedIds: Set<string> | null = prepared?.team ? new Set(prepared.team.approvers.filter(a => !a.isYou && !a.confirmed).map(a => a.userId)) : prepared ? new Set() : null;

  const handleCommit = async () => {
    if (!authData || !gateData || !profile || !user) return;
    if (!authData.groupId) {
      setError('No active group; cannot create mandate.');
      return;
    }
    // A chain gateway gives with the shared driver (Touch ID, progress, result) — the same as the approval card.
    if (chain) { setError(''); await driver.give(); return; }
    setSubmitting(true);
    setError('');
    try {
      // Edit flow: this ceremony supersedes an existing grant. Grants are
      // content-immutable (the attestation signature freezes bounds/scope/
      // intent), so "edit" = sign a NEW grant, then revoke the old one below.
      const replacesId = sessionStorage.getItem('agentEditReplaces') || undefined;
      // DL6 "Edit before signing": this ceremony was opened from a pending
      // setup__create_mandate PROPOSAL, not an existing grant — withdrawn
      // (rejected) below only once this signing fully succeeds, never before
      // (decision 6: "nothing is created until the person signs there").
      const replacesProposalId = sessionStorage.getItem('agentReplacesProposal') || undefined;
      // The control plane runs the signing steps (hash, encrypt for the team's
      // approvers, Authority Server, deliver the intent) — the same code as the
      // AI path. A refusal arrives as an error with the reason.
      const { authorizationId, revokeError } = await spClient.signMandate({
        team: authData.isPersonal ? 'personal' : authData.groupId,
        profile: authData.profileId,
        limits: gateData.bounds as Record<string, string | number>,
        scope: gateData.context as Record<string, string | number>,
        contextLabels: gateData.contextLabels,
        intent: gateData.gateContent.intent,
        mode: toProtocolMode(commitMode),
        ttlSeconds,
        title: authTitle.trim(),
        discloseIdentity,
        replaces: replacesId,
        // a chain gateway gives only what it prepared for this page
        ...(chain && prepared ? { planHash: prepared.planHash } : {}),
      });

      // A failed revoke of the old mandate must be told, never swallowed
      // (lib/mandate-ceremony.ts retires it only after the new one is delivered).
      const revokeProblem = replacedRevokeProblem(revokeError);

      // DL6 "Edit before signing": the mandate is signed AND delivered —
      // withdraw the proposal it was opened from, so the two can never both
      // exist (decision 6, "no double"). Best effort, same reasoning as the
      // grant-replace block above: the new mandate is live either way; a
      // proposal left pending here is still visible for manual rejection.
      // RJ2/RJ5: this is not a refusal — the person signed their own version
      // — so it carries outcome `replaced`, not a plain reject (the AI must
      // use the mandate, not retry the proposal's own values).
      // The route depends on the proposal: a review proposal is decided per
      // domain (/resolve), an above-cap one by its approvers (/reject). Using
      // /reject for everything left review proposals PENDING (found live
      // 2026-10-12). A failure is shown, never swallowed.
      const withdrawProblem = replacesProposalId ? await closeReplacedProposal(replacesProposalId, user?.id ?? '') : '';

      sessionStorage.removeItem('agentAuth');
      sessionStorage.removeItem('agentGate');
      sessionStorage.removeItem('agentEditReplaces');
      sessionStorage.removeItem('agentReplacesProposal');
      sessionStorage.removeItem('agentChangeAiIntent');
      if (revokeProblem) {
        // Stay on the page: a mandate the person believes is replaced is still live.
        setError(revokeProblem);
        return;
      }
      if (withdrawProblem) {
        // The mandate is live; only the AI's proposal is still open. Stay on
        // the page and say what to do instead of hiding it.
        setError(`Your mandate is signed and active. The AI's proposal could not be withdrawn (${withdrawProblem}) — reject it under Approvals.`);
        return;
      }
      navigate(`/mandates?highlight=${encodeURIComponent(authorizationId)}`);
    } catch (e) {
      if (chain && e instanceof MandateSignError) {
        if (e.code === 'approver_identity_unconfirmed' || e.code === 'changed_since_prepare' || e.code === 'prepare_required') setPrepareTick(0);   // look at the plan again
        if (e.code !== 'approver_identity_unconfirmed') setError(giveErrorText({ code: e.code, reason: e.reason, approverNames: (e.approverIds ?? []).map(id => approverNames[approverIds.indexOf(id)] ?? '').filter(Boolean) }));
        return;
      }
      setError(e instanceof Error ? e.message : 'Signing the mandate failed');
    } finally {
      setSubmitting(false);
    }
  };

  // "Give on your phone" (DEC-90) and the Touch ID give: the shared driver.
  const phoneOffered = driver.phoneOffered;
  const handleGiveOnPhone = driver.giveOnPhone;
  const handleStopPhone = driver.stopPhone;
  // Given (here or on the phone): the hand-over keys go, the result stays on screen.
  useEffect(() => {
    if (!driver.givenId || !authData) return;
    for (const k of ['agentAuth', 'agentGate', 'agentEditReplaces', 'agentReplacesProposal', 'agentChangeAiIntent']) sessionStorage.removeItem(k);
    if (driver.error) { setError(driver.error); return; }
    setGiven({ authorizationId: driver.givenId, text: S13.giveDone(profileDisplayName(authData.profileId), endDateText(Date.now(), ttlSeconds)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driver.givenId]);
  useEffect(() => { if (driver.error) setError(driver.error); }, [driver.error]);

  if (!authData || !gateData) {
    return <GiveSkeleton />;
  }
  if (given) {
    // The gateway's own result stamp (DEC-86/88), then back to the mandate list, where the new mandate is marked.
    return (
      <div className="card av3-card av3-given-alone" style={{ maxWidth: 560 }} data-testid="give-done">
        <GiveTouchFooter view={{ s: 'given' }} onGive={() => {}} onBack={() => {}} onClose={() => navigate(`/mandates?highlight=${encodeURIComponent(given.authorizationId)}`)} />
      </div>
    );
  }

  // Outside simulation, a limit only test-data tools use is not listed; it is still signed.
  const hiddenLimits = hiddenLimitKeys(profile, sourceManifests as ManifestGatingLike[] | undefined, simulation);
  const boundsEntries = Object.entries(gateData.bounds).filter(([k]) => k !== 'profile' && k !== 'path' && !hiddenLimits.has(k));
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
  // The AS's team authority gate (PROFILE_NOT_ENABLED_FOR_GROUP /
  // OWNER_NOT_APPROVER), same rule as the profile picker — block the button
  // and say why, instead of letting the person sign into a refusal.
  const right = mandateRight({
    isPersonal: authData.isPersonal,
    configLoaded: profileConfigLoaded,
    // TR5 — who may GRANT, not who may approve above cap.
    grantors: profileConfig ? effectiveGrantors(profileConfig) : undefined,
    userId: user?.id,
    profileName: profileDisplayName(authData.profileId),
    teamName: authData.groupName,
    isAdmin: isTeamAdmin(activeTeam, activeMembership, user?.id),
  });
  const blockedByTeamGate = !right.can;
  const giveCaps = Object.entries(profileConfig?.caps ?? {}).map(([k, v]) => ({ label: profile?.boundsSchema?.fields?.[k]?.displayName ?? k, value: limitValueText(profile?.boundsSchema?.fields?.[k], v) }));
  const giveCapText = giveCaps.length === 0 ? null : giveCaps.length === 1 ? giveCaps[0].value : giveCaps.map(c => `${c.label} ${c.value}`).join(', ');
  const approverBlocked = chain && giveBlocked(approverLines(approverIds.map(id => ({ userId: id, name: id })), unconfirmedIds), user?.id);
  // The profile may allow only some modes (e.g. review only); offer exactly
  // those — the AS refuses any other (commitment_mode_not_allowed).
  const offeredModes = offeredCommitModes(profile);
  const noModeAllowed = offeredModes.length === 0;
  // The profile's `scopeSchema.atLeastOne`: while the limits allow a listed action,
  // one of the group's fields must be filled — the gateway refuses to sign otherwise.
  const atLeastOneUnmet = profile ? unmetForMandate(profile, gateData.context, gateData.bounds) : [];
  const ttlExceedsMax = ttlSeconds > ttlMax;
  const commitStyleImmediate = {
    flex: 1,
    padding: '0.75rem',
    border: commitMode === 'immediate' ? '2px solid var(--accent)' : '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    background: commitMode === 'immediate' ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
    cursor: 'pointer' as const,
    textAlign: 'left' as const,
    fontFamily: 'inherit',
  };
  const commitStylePerAction = {
    flex: 1,
    padding: '0.75rem',
    border: commitMode === 'per-action' ? '2px solid var(--accent)' : '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    background: commitMode === 'per-action' ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
    cursor: 'pointer' as const,
    textAlign: 'left' as const,
    fontFamily: 'inherit',
  };

  // ── Structural overlap ────────────────────────────────────────────────────
  // Deterministic and profile-agnostic: two grants overlap iff their context
  // scopes intersect (bounds are magnitudes, not partitions — see
  // scope-overlap.ts). Driven entirely off the profile's context schema, so it
  // works for any profile. Always advisory — never blocks signing. Disjoint
  // scopes produce no warning. Semantic/intent overlap is the on-device AI
  // (Phase 2).
  const contextKeys = profile?.scopeSchema?.keyOrder ?? [];
  const overlappingGrants = existingSameProfile.filter(g =>
    scopesOverlap(contextKeys, gateData.context, g.context),
  );
  const hasOverlap = overlappingGrants.length > 0;
  const overlapProfileName = profileDisplayName(authData.profileId);
  const describeScope = (ctx: AgentScopeParams): string => {
    const vals = Object.values(ctx).map(v => String(v).trim()).filter(Boolean);
    return vals.length > 0 ? vals.join(', ') : 'all (unscoped)';
  };
  const overlapScopes = overlappingGrants.map(g => describeScope(g.context)).join('; ');
  // Copy must match the gateway's ACTUAL selection behaviour (scope-specificity.ts
  // + tool-proxy.ts). Three distinct effects, and they don't all go the same way:
  //   - per-action bounds: the stricter grant fails verification and drops out of
  //     the candidate set, so the more permissive value effectively applies;
  //   - cumulative bounds: each authorization carries its OWN counter, so an
  //     exhausted grant drops out and the overlapping one takes over — the limits
  //     ADD UP rather than the larger one winning;
  //   - commitment mode: selection explicitly prefers an approver
  //     ('fail-safe-approval'), so review is NOT weakened by an automatic twin.
  // The earlier copy said "the more permissive limits effectively apply" for all
  // three — understating the cumulative case and overstating the mode case.
  const giveSummary = giveSummaryLine({ limits: gateData.bounds as Record<string, string | number>, scope: gateData.context, durationSeconds: ttlSeconds, boundsSchema: profile?.boundsSchema as never, scopeSchema: profile?.scopeSchema as never, hidden: hiddenLimits });
  const overlapWarningText = `This grant's scope overlaps an existing grant on ${overlapProfileName} (scoped to: ${overlapScopes}). The agent may act under either. Per-action limits take the more permissive value, and daily limits add together — two grants of 10/day allow 20/day. Approval is not weakened: if either grant requires review, review still applies. Confirm this is intended before authorizing.`;

  const giveDisabled = submitting || approverBlocked || (chain && (!prepared || !!prepared.blocked)) || !authTitle.trim() || blockedByTeamGate || noModeAllowed || ttlSeconds <= 0 || atLeastOneUnmet.length > 0;

  return (
    <>
      <StepIndicator currentStep={4} onStepClick={s => {
        if (s <= 3) navigate(`/mandates/new/intent?step=${s}`);
      }} />

      {/* DEC-98: the whole review card appears once the profile and its team rules are in. */}
      <LoadGate parts={['give']}>
      <Gated part="give" ready={(!!profile || profileFailed) && profileConfigLoaded} skeleton={<GiveSkeleton bare />}>
      <div className="card">
        <h3 className="card-title" style={{ marginBottom: '0.25rem' }}>Review &amp; Commit</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
          Review your mandate details before signing.
        </p>
        {chain && giveSummary && <p className="sum-line" data-testid="mandate-summary">{giveSummary}</p>}

        {/* Copy/Edit moved this mandate to a newer profile version — the AS
            refuses to sign a new one under the old version it was pinned to
            (old versions stay listable for history, never issuable again). */}
        {authData.upgradedFromProfileId && profile && (
          <div className="hint-box" role="note" style={{ marginBottom: '1rem' }}>
            <span className="hint-icon" aria-hidden="true">i</span>
            <div className="hint-body">
              Updated to {profileDisplayName(authData.profileId)} {profile.version} — the current version of this profile.
            </div>
          </div>
        )}

        {error && <div className="error-message">{error}</div>}

        {/* Replacing a signed mandate: the differences, as on the change card. */}
        {editDiff && (
          <div className="info-block" data-testid="edit-diff">
            <MandateChangeDiff diff={editDiff} intentByAi={!!aiIntent && aiIntent === gateData.gateContent.intent} />
          </div>
        )}

        {/* Title — first: it names the decision everything below describes. */}
        <div className="field-editable">
          <div className="field-label"><span className="pen">✎</span> Title</div>
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
            A short name to identify this mandate on your dashboard.
          </div>
        </div>

        {/* Commitment mode — Review first and default: the agent proposes,
            the human approves. Automatic is the deliberate opt-in. */}
        <div className="field-editable">
          <div className="field-label"><span className="pen">✎</span> {COMMITMENT_LABEL}</div>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            {offeredModes.includes('per-action') && (
            <button onClick={() => setCommitMode('per-action')} style={commitStylePerAction}>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--text-primary)' }}>{COMMITMENT_REVIEW.title}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {COMMITMENT_REVIEW.text}
              </div>
            </button>
            )}
            {offeredModes.includes('immediate') && (
            <button onClick={() => setCommitMode('immediate')} style={commitStyleImmediate}>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--text-primary)' }}>{COMMITMENT_AUTOMATIC.title}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {COMMITMENT_AUTOMATIC.text}
              </div>
            </button>
            )}
          </div>
          {offeredModes.length === 1 && (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
              {offeredModes[0] === 'per-action'
                ? 'This profile only allows review: you approve each action before it runs.'
                : 'This profile only allows automatic mode.'}
            </div>
          )}
          {noModeAllowed && (
            <div className="msg-error" style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
              This profile allows no commitment mode, so no mandate can be signed under it. Its publisher must fix the profile.
            </div>
          )}
        </div>

        {/* Duration selector */}
        <div className="field-editable">
        <div className="field-label"><span className="pen">✎</span> Duration</div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
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
          {ttlSeconds <= 0 && (
            <p className="cta-helper" data-testid="duration-needed" style={{ width: '100%', margin: 0 }}>Choose how long this mandate should last.</p>
          )}
          {ttlExceedsMax && (
            <span className="msg-error" style={{ fontSize: '0.75rem' }}>
              Maximum: {ttlMax >= 86400 ? `${Math.floor(ttlMax / 86400)} days` : `${Math.floor(ttlMax / 3600)} hours`}
            </span>
          )}
          {chain && ttlSeconds > 0 && !ttlExceedsMax && (
            <span data-testid="give-end" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              {S13.giveUntil(durationText(ttlSeconds), endDateText(Date.now(), ttlSeconds))}
            </span>
          )}
        </div>
        </div>

        <div className="field-editable">
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={alwaysDisclose || discloseIdentity}
              disabled={alwaysDisclose}
              onChange={e => setDiscloseIdentity(e.target.checked)}
              style={{ marginTop: '0.15rem' }}
            />
            <span style={{ fontSize: '0.8rem' }}>
              Show my verified name on actions under this mandate
              <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginTop: '0.15rem' }}>
                Adds "verified by Suveren" with your name to outgoing content. Takes effect
                only if your identity is verified; otherwise actions stay pseudonymous.
                {alwaysDisclose && ' Always on — you chose this in Settings.'}
              </div>
            </span>
          </label>
        </div>

        {/* ── The record: decisions made in steps 2–3, quiet by design.
              Each block links back to the step that owns it. ── */}
        <div className="info-section-label">What you are signing — set in previous steps</div>

        <div className="info-block">
          <div className="info-head">
            <span className="info-title">Intent</span>
            <button className="info-edit" onClick={() => navigate('/mandates/new/intent?step=3')}>edit in step 3</button>
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{gateData.gateContent.intent}</div>
        </div>

        {(!!boundsEntries.length || !!contextEntries.length) && (
          <div className="info-block">
            <div className="info-head">
              <span className="info-title">Scope &amp; Limits</span>
              <button className="info-edit" onClick={() => navigate('/mandates/new/intent?step=2')}>edit in step 2</button>
            </div>
            <dl className="info-kv">
              {chain && prepared && prepared.scope.map(r => (
                <span key={`p-${r.field}`} style={{ display: 'contents' }}><dt>{r.label}</dt><dd>{limitValueText({ unit: r.unit }, r.value)}</dd></span>
              ))}
              {chain && prepared && prepared.bounds.map(r => (
                <span key={`p-${r.field}`} style={{ display: 'contents' }}><dt>{r.label}</dt><dd>{limitValueText({ unit: r.unit }, r.value)}</dd></span>
              ))}
              {!(chain && prepared) && contextEntries.map(([k, v]) => (
                <span key={k} style={{ display: 'contents' }}>
                  <dt>{chain ? scopeLabel(k, profile?.scopeSchema) : k}</dt>
                  <dd>{formatScopeFieldValue(k, v, profile?.scopeSchema?.fields?.[k], sourceManifests, gateData.contextLabels)}</dd>
                </span>
              ))}
              {!(chain && prepared) && boundsEntries.map(([k, v]) => (
                <span key={k} style={{ display: 'contents' }}>
                  <dt>{chain ? (profile?.boundsSchema?.fields?.[k]?.displayName ?? k) : k}</dt>
                  <dd>{chain ? limitValueText(profile?.boundsSchema?.fields?.[k], v as string | number) : String(v)}</dd>
                </span>
              ))}
            </dl>
          </div>
        )}

        <div className="info-block">
        <div className="info-head">
          <span className="info-title">Authority</span>
        </div>
        <dl className="info-kv">
          <dt>Profile</dt>
          <dd>
            {profileDisplayName(authData.profileId)}
            <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.125rem' }}>{authData.profileId}</div>
          </dd>
          {!authData.isPersonal && authData.groupName && (
            <>
              <dt>Team</dt>
              <dd>{authData.groupName}</dd>
            </>
          )}
          {/* Approvers row — always visible in team mode so the creator
              knows whether anyone else can read their intent. Hidden for a
              personal workspace, where approvers are never required. */}
          {!authData.isPersonal && (
            <>
              <dt>Approvers</dt>
              <dd>
                {!profileConfigLoaded ? (
                  <span style={{ color: 'var(--text-tertiary)' }}>Loading…</span>
                ) : !right.can ? (
                  <>
                    <span className="msg-error">
                      {right.code === 'PROFILE_NOT_ENABLED_FOR_GROUP' ? `Not enabled for ${authData.groupName ?? 'this team'}` : 'You cannot give this mandate'}
                    </span>
                    {right.code === 'OWNER_NOT_APPROVER' && <div>{approverNamesStr}</div>}
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.125rem' }}>
                      {right.reason} {right.fix}
                    </div>
                    {right.adminCanEnable && teamSettingsHref(spUrl, authData.groupId) && (
                      <a className="btn btn-secondary btn-sm" style={{ marginTop: '0.5rem', textDecoration: 'none' }} href={teamSettingsHref(spUrl, authData.groupId)} target="_blank" rel="noopener noreferrer" data-testid="enable-in-team-settings">
                        {ENABLE_IN_TEAM_SETTINGS}
                      </a>
                    )}
                  </>
                ) : chain && approverIds.length > 0 ? (
                  <GiveApprovers
                    capText={giveCapText}
                    count={profileConfig?.approvals ?? 1}
                    approvers={approverLines(approverIds.map((id, i) => ({ userId: id, name: approverNames[i] ?? id })), unconfirmedIds)}
                    adminName={adminName || S13.heldAdminUnknown}
                    ownId={user?.id}
                    mode={toProtocolMode(commitMode)}
                  />
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
        </dl>
        </div>

        {/* Duplicate bounds — advisory; the user probably meant to Extend.
            Per-ceremony identity makes a twin harmless on the AS, so this
            never blocks — it just points at the cheaper path. */}
        {duplicateBoundsCount > 0 ? (
          <div style={{
            display: 'flex', gap: '0.625rem',
            padding: '0.75rem 0.875rem', marginBottom: '1.25rem',
            border: '1px dashed var(--border-strong)', borderLeft: '3px dashed var(--text-primary)',
            borderRadius: '0.5rem', background: 'var(--bg-elevated)',
            fontSize: '0.82rem', color: 'var(--text-primary)',
          }}>
            <span aria-hidden="true" style={{ fontWeight: 700 }}>!</span>
            <div>
              <div style={{ fontWeight: 600, marginBottom: '0.2rem' }}>
                Identical limits to an existing grant
              </div>
              <div>
                {duplicateBoundsCount === 1
                  ? `An active grant on ${overlapProfileName} already has exactly these limits.`
                  : `${duplicateBoundsCount} active grants on ${overlapProfileName} already have exactly these limits.`}
                {' '}If you meant to give the existing grant more time, use <strong>Extend</strong> on
                the Mandates page instead — authorizing here creates a separate,
                independent grant with its own intent and usage counters.
              </div>
            </div>
          </div>
        ) : null}

        {/* Structural overlap — advisory; fires only on genuine scope overlap */}
        {hasOverlap ? (
          <div style={{
            display: 'flex', gap: '0.625rem',
            padding: '0.75rem 0.875rem', marginBottom: '1.25rem',
            border: '1px dashed var(--border-strong)', borderLeft: '3px dashed var(--text-primary)',
            borderRadius: '0.5rem', background: 'var(--bg-elevated)',
            fontSize: '0.82rem', color: 'var(--text-primary)',
          }}>
            <span aria-hidden="true" style={{ fontWeight: 700 }}>!</span>
            <div>
              <div style={{ fontWeight: 600, marginBottom: '0.2rem' }}>
                Overlapping scope
              </div>
              <div>{overlapWarningText}</div>
            </div>
          </div>
        ) : null}

        {atLeastOneUnmet.length > 0 && profile && (
          <p className="cta-helper" data-testid="at-least-one-needed" style={{ marginBottom: '0.5rem' }}>
            {atLeastOneSignHint(profile, atLeastOneUnmet[0])}
          </p>
        )}

        {chain && prepared?.blocked && prepared.blocked.code !== 'approver_identity_unconfirmed' && !phoneOffered && (
          <p role="alert" data-testid="give-prepare-blocked" className="msg-error">{giveErrorText({ code: prepared.blocked.code })}</p>
        )}
        {chain && !prepared && prepareError && <p role="alert" data-testid="give-prepare-error" className="msg-error">{prepareError}</p>}
        {chain && !phoneOffered && phoneGive.s === 'offered' && (
          <p className="cta-helper" data-testid="give-touch-note" style={{ marginBottom: '0.5rem' }}>
            {S13.giveTouchNote.replace('{area}', profileDisplayName(authData.profileId))}
            {approverBlocked && <> <button type="button" className="info-edit" onClick={() => setPrepareTick(0)}>{S13.heldCheckAgain}</button></>}
          </p>
        )}

        {phoneOffered || phoneGive.s !== 'offered' ? (
          <div className="card av3-card" data-testid="give-phone-card" style={{ position: 'relative' }}>
            <GivePhoneFooter
              view={phoneGive.s === 'refused' ? { s: 'refused', message: phoneGive.message } : { s: phoneGive.s }}
              disabled={!giveRequest || !prepared || approverBlocked || !authTitle.trim() || blockedByTeamGate || noModeAllowed || ttlSeconds <= 0 || atLeastOneUnmet.length > 0}
              onGive={() => { void handleGiveOnPhone(); }}
              onStop={handleStopPhone}
              onClose={() => {
                if (phoneGive.s === 'given') { navigate(`/mandates?highlight=${encodeURIComponent(phoneGive.authorizationId)}`); return; }
                if (phoneGive.s === 'offered') { navigate('/mandates/new/intent'); return; }
                driver.resetPhone();
              }}
            />
            {phoneGive.s === 'given' && (
              <div className="av3-foot">
                <button type="button" className="av3-btn av3-btn-primary" style={{ width: '100%' }} onClick={() => navigate(`/mandates?highlight=${encodeURIComponent(phoneGive.authorizationId)}`)} data-testid="give-phone-done">Go to my mandates</button>
              </div>
            )}
          </div>
        ) : chain ? (
          <div className="card av3-card" style={{ position: 'relative' }}>
            <GiveTouchFooter
              view={touchView}
              disabled={submitting || approverBlocked || !prepared || !!prepared.blocked || !authTitle.trim() || blockedByTeamGate || noModeAllowed || ttlSeconds <= 0 || atLeastOneUnmet.length > 0}
              onGive={() => { void handleCommit(); }}
              onBack={() => navigate('/mandates/new/intent')}
              onClose={() => {}}
            />
          </div>
        ) : (
        <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn-ghost" onClick={() => navigate('/mandates/new/intent')}>Back</button>
            <button
              className="btn btn-primary btn-lg"
              style={{ flex: 1 }}
              onClick={handleCommit}
              disabled={giveDisabled}
            >
              {chain ? (submitting ? S13.giveBusy : S13.giveButton) : submitting ? 'Signing...' : commitMode === 'immediate' ? 'Sign mandate' : 'Sign mandate (asks first)'}
            </button>
          </div>
        )}

        <div style={{ marginTop: '1rem', fontSize: '0.75rem', color: 'var(--text-tertiary)', textAlign: 'center', display: showBottomNote ? 'block' : 'none' }}>
          {bottomNote}
        </div>
      </div>
      </Gated>
      </LoadGate>
    </>
  );
}

/** DEC-98: the review card greyed out — title, summary, the detail blocks and the give button, at the real sizes. */
function GiveSkeleton({ bare }: { bare?: boolean }) {
  const card = (
    <div className="card" data-testid="give-skeleton">
      <SkelArea>
        <SkelLine w="35%" h="1.2rem" style={{ marginBottom: '0.5rem' }} />
        <SkelLine w="55%" style={{ marginBottom: '1.5rem' }} />
        <SkelLine w="80%" style={{ marginBottom: '1.25rem' }} />
        <SkelBlock h="6rem" radius="0.75rem" style={{ marginBottom: '0.75rem' }} />
        <SkelBlock h="5rem" radius="0.75rem" style={{ marginBottom: '0.75rem' }} />
        <SkelBlock h="4rem" radius="0.75rem" style={{ marginBottom: '1.5rem' }} />
        <SkelButton full large />
      </SkelArea>
    </div>
  );
  return bare ? card : <>{card}</>;
}

