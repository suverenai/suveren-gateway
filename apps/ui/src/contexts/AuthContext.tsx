import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { setAsHost } from '@suveren/approval-card/lib/as-host';
import { spClient, deviceDecisionsFromHealth, SESSION_GONE_EVENT, sessionEvents, type SessionGoneDetail, type SPUser, type SPGroup, type GroupMember, type PendingJoinRequest } from '../lib/sp-client';
import { deviceClient } from '../lib/device-client';
import { accessFromProbe, LEGACY, type Access, type AccessState } from '../lib/access';

export type GatewayMode = 'personal' | 'team';

export interface AuthContextValue {
  user: SPUser | null;
  /**
   * How this page gets in (lib/access.ts). `legacy` is the account-key sign-in of every gateway without an unlock
   * password; `password` is the unlock password or Touch ID and a page session. `null` until the gateway answered.
   */
  access: Access | null;
  /** The control plane runs with device keys on (its password routes answer). */
  deviceKeysSwitch: boolean;
  passwordSet: boolean;
  /** The page holds a page session (password gateways only). */
  pageSessionOpen: boolean;
  /** Why the last page session ended (a session code), for the unlock screen. */
  sessionEnd: string | null;
  /** Ask the gateway again how the page gets in (after a password was set). */
  refreshAccess: () => Promise<AccessState>;
  /** The page has a session: keep its token in memory and send it on every request. `token` is absent when only the vault opened. */
  openPageSession: (token?: string) => void;
  /** Sign in by what the gateway already holds (device key): reads the person and the workspace. False if it cannot. */
  adoptSessionUser: () => Promise<boolean>;
  /** After the account-key sign-in inside a page session, nothing more to do here; kept for symmetry. */
  clearSessionEnd: () => void;
  mode: GatewayMode;
  /** In team mode: the user's team. In personal mode: the auto-provisioned
   *  personal workspace (`isPersonal: true`) — never null once logged in. */
  group: SPGroup | null;
  /** The user's active domain. Personal: 'owner'. Team: from group membership. */
  domain: string;
  /** The active group's ID — the personal workspace's in personal mode. It is
   *  required on every attestation, so it is NOT a "this is a team" signal;
   *  use `mode` or `group.isPersonal` for that. */
  groupId: string | null;
  /** The active team group (null for personal-only users). */
  activeTeam: SPGroup | null;
  /** The caller's active membership record (null for personal-only users). */
  activeMembership: GroupMember | null;
  /**
   * The caller's own pending request to join a team (work-plan "Added
   * 2026-10-11 — an account is Personal OR in one team") — null when there
   * is none. Mutually exclusive with `activeTeam` by construction (the
   * Authority Server refuses a new request while one is active), but kept
   * independent here so OnboardingPage never has to assume that itself.
   */
  pendingRequest: PendingJoinRequest | null;
  isLoading: boolean;
  error: string;
  /**
   * Log in with an API key. If the local vault belongs to a different
   * account, throws `DifferentAccountError` (re-exported from sp-client).
   * The caller should show a confirmation UI and retry with
   * `{ confirmWipe: true }` to proceed.
   */
  login: (apiKey: string, opts?: { confirmWipe?: boolean }) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
  /**
   * The gateway locked ITSELF because the Authority Server session ended
   * (30-day expiry, or revoked) — signalled by the 'session-locked' SSE
   * event. Unlike logout(), the server side is already locked; this only
   * resets local UI state (no /auth/logout call — the API key that call
   * would use is itself now invalid) and surfaces `message` as the reason
   * so the sign-in screen can explain why the user landed there.
   */
  handleSessionLocked: (message?: string) => void;

  // Kept for backward compat — components that haven't been updated yet
  /** @deprecated Use group */
  activeGroup: SPGroup | null;
  /** @deprecated Use domain */
  activeDomain: string;
  /** @deprecated Use group */
  groups: SPGroup[];
  /** @deprecated No longer needed */
  setActiveContext: (group: SPGroup | null, domain: string) => void;
  /** Refreshes team membership from SP and recomputes mode. */
  refreshGroups: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SPUser | null>(null);
  const [accessState, setAccessState] = useState<AccessState | null>(null);
  const [pageSessionOpen, setPageSessionOpen] = useState(false);
  const [sessionEnd, setSessionEnd] = useState<string | null>(null);
  const [mode, setMode] = useState<GatewayMode>('personal');
  const [group, setGroup] = useState<SPGroup | null>(null);
  const [domain, setDomain] = useState('');
  const [activeTeam, setActiveTeam] = useState<SPGroup | null>(null);
  const [activeMembership, setActiveMembership] = useState<GroupMember | null>(null);
  const [pendingRequest, setPendingRequest] = useState<PendingJoinRequest | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Track whether we have an active API key (user is logged in) so
  // visibilitychange handler knows whether to fire refreshGroups.
  const hasApiKey = useRef(false);

  // Track the latest userId so refreshGroups can read it synchronously
  // without depending on the closure-captured `user` (which lags one tick
  // behind setUser inside the same login() call).
  const userIdRef = useRef<string | null>(null);

  /**
   * Fetches /api/groups/me, updates activeTeam + activeMembership +
   * pendingRequest, and computes mode = activeMembership ? 'team' :
   * 'personal'. Also syncs the legacy `group` / `domain` state for
   * back-compat.
   */
  const refreshGroups = useCallback(async () => {
    if (!hasApiKey.current) return;
    try {
      const result = await spClient.getMyTeam();
      setPendingRequest(result.pendingRequest);
      if (result.group && result.membership) {
        const { group: teamGroup, membership } = result;
        setActiveTeam(teamGroup);
        setActiveMembership(membership);
        setMode('team');
        setGroup(teamGroup);
        // P4.6: team-group domain is the caller's userId. Read from the
        // ref so we get the latest value even if state hasn't propagated.
        // Fallback to legacy membership.domains[0] is intentional — guards
        // against any code path that could leave userIdRef unset.
        const firstDomain = userIdRef.current ?? membership.domains[0] ?? 'owner';
        setDomain(firstDomain);
      } else {
        setActiveTeam(null);
        setActiveMembership(null);
        setMode('personal');
        // Keep existing personal group in `group` state; don't wipe domain
        // because we may have set it during login from getGroups.
      }
    } catch {
      // Network error — leave existing state as-is
    }
  }, []);

  // Refresh on tab refocus — catches joins/leaves done in another tab or SP UI
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshGroups();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [refreshGroups]);

  // Boot-time-only counterpart to handleSessionLocked's runtime message: an
  // AS-URL change is detected while the gateway is starting (index.ts), so
  // there is no live session to interrupt with an SSE event — the vault is
  // already locked by the time anyone can connect. /health is unauthenticated
  // (see UpdateBanner, which already relies on this), so this can run before
  // login without an API key.
  useEffect(() => {
    fetch('/health')
      .then(res => res.json())
      .then((health: { spUrl?: string; deviceKeys?: boolean; session?: { lockedReason?: string } }) => {
        // A gateway with device keys signs its decisions in the control plane (step 12); one without keeps the legacy path.
        spClient.setDeviceDecisions(deviceDecisionsFromHealth(health));
        // The sentences name the Authority Server this gateway uses, not always suveren.ai.
        setAsHost(health.spUrl);
        if (health.session?.lockedReason === 'as-url-changed') {
          setError(`Authority Server changed to ${health.spUrl ?? 'a new server'} — sign in again.`);
        }
      })
      .catch(() => { /* health unreachable — the rest of the app already surfaces this */ });
    // Once only, on mount — a runtime change is covered by the 'session-locked'
    // SSE event (see App.tsx), not this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // How does this page get in? An unauthenticated probe of the password routes: switch off answers 404, which is
  // today's page; a gateway without a password also keeps the account-key sign-in.
  const refreshAccess = useCallback(async (): Promise<AccessState> => {
    const next = accessFromProbe(await deviceClient.passwordStatus());
    setAccessState(next);
    return next;
  }, []);
  useEffect(() => { void refreshAccess(); }, [refreshAccess]);

  const clearSessionEnd = useCallback(() => setSessionEnd(null), []);

  const openPageSession = useCallback((token?: string) => {
    if (token) {
      spClient.setSessionToken(token);
      setPageSessionOpen(true);
      setSessionEnd(null);
    }
  }, []);

  const adoptSessionUser = useCallback(async (): Promise<boolean> => {
    const u = await spClient.loadSessionUser();
    if (!u) return false;
    hasApiKey.current = true;
    userIdRef.current = u.id;
    setUser(u);
    const allGroups = await spClient.getGroups().catch(() => [] as SPGroup[]);
    setGroup(allGroups.find(g => g.isPersonal) ?? allGroups[0] ?? null);
    setDomain('owner');
    await refreshGroups();
    // Signed approvals: only now that the page has its session does the gateway answer whether decisions are signed here.
    await spClient.detectDeviceDecisions();
    return true;
  }, [refreshGroups]);

  const login = useCallback(async (apiKey: string, opts: { confirmWipe?: boolean } = {}) => {
    setIsLoading(true);
    setError('');
    try {
      spClient.setApiKey(apiKey);
      hasApiKey.current = true;
      const u = await spClient.login(apiKey, opts);
      setUser(u);
      // Sync ref so refreshGroups (called below) reads the latest userId
      // synchronously, before React has propagated the setUser update.
      userIdRef.current = u.id;

      // Always seed the personal group so group_id is non-null for personal mode.
      // We call getGroups once to get the personal group, then refreshGroups to
      // get the true team membership state from the SP singleton endpoint.
      const allGroups = await spClient.getGroups();
      const personal = allGroups.find(g => g.isPersonal) ?? allGroups[0] ?? null;
      setGroup(personal);
      setDomain('owner');

      // Derive mode from real membership — replaces the old HAP_MODE env branch
      await refreshGroups();
      // A password gateway's page has its session by now: ask whether decisions are signed with this computer's key.
      if (spClient.hasPageSession()) await spClient.detectDeviceDecisions();
    } catch (e) {
      spClient.clearApiKey();
      hasApiKey.current = false;
      setError(e instanceof Error ? e.message : 'Login failed');
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, [refreshGroups]);

  const logout = useCallback(async () => {
    await spClient.logout();
    spClient.clearApiKey();
    spClient.setSessionToken(null);
    setPageSessionOpen(false);
    hasApiKey.current = false;
    userIdRef.current = null;
    setUser(null);
    setGroup(null);
    setDomain('');
    setActiveTeam(null);
    setActiveMembership(null);
    setPendingRequest(null);
    setMode('personal');
    setError('');
  }, []);

  const handleSessionLocked = useCallback((message?: string) => {
    spClient.clearApiKey();
    spClient.setSessionToken(null);
    setPageSessionOpen(false);
    hasApiKey.current = false;
    userIdRef.current = null;
    setUser(null);
    setGroup(null);
    setDomain('');
    setActiveTeam(null);
    setActiveMembership(null);
    setPendingRequest(null);
    setMode('personal');
    setError(message ?? 'Your sign-in ended after 30 days or was revoked. Sign in again.');
  }, []);

  // The gateway stopped accepting this tab's session (restart → vault locked,
  // or the session ended without an SSE event reaching us): go to sign-in with
  // the reason, exactly like 'session-locked'.
  useEffect(() => {
    const onGone = (e: Event) => {
      // A gateway with a page session says why it ended (idle, 12 hours, closed, locked): the unlock screen shows it.
      if (spClient.hasPageSession()) {
        const code = (e as CustomEvent<SessionGoneDetail>).detail?.code ?? 'session_missing';
        spClient.setSessionToken(null);
        spClient.clearApiKey();
        setPageSessionOpen(false);
        hasApiKey.current = false;
        userIdRef.current = null;
        setUser(null);
        setGroup(null);
        setDomain('');
        setActiveTeam(null);
        setActiveMembership(null);
        setPendingRequest(null);
        setMode('personal');
        setError('');
        setSessionEnd(code);
        return;
      }
      if (!hasApiKey.current) return;
      handleSessionLocked('The gateway restarted or your sign-in ended. Sign in to unlock it.');
    };
    sessionEvents.addEventListener(SESSION_GONE_EVENT, onGone);
    return () => sessionEvents.removeEventListener(SESSION_GONE_EVENT, onGone);
  }, [handleSessionLocked]);

  const clearError = useCallback(() => setError(''), []);

  // Backward compat
  const setActiveContext = useCallback((g: SPGroup | null, d: string) => {
    setGroup(g);
    setDomain(d);
  }, []);

  return (
    <AuthContext.Provider value={{
      user, mode, group, domain,
      access: accessState ? accessState.access : null,
      deviceKeysSwitch: accessState?.switchOn ?? LEGACY.switchOn,
      passwordSet: accessState?.passwordSet ?? false,
      pageSessionOpen, sessionEnd, refreshAccess, openPageSession, adoptSessionUser, clearSessionEnd,
      groupId: group?.id ?? null,
      activeTeam,
      activeMembership,
      pendingRequest,
      isLoading, error, login, logout, clearError, handleSessionLocked,
      // Backward compat aliases
      activeGroup: group,
      activeDomain: domain,
      groups: group ? [group] : [],
      setActiveContext,
      refreshGroups,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
