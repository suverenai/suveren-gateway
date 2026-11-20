import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextValue } from './contexts/AuthContext';
import { AppRoutes } from './App';
import { UnlockPage } from './components/device/UnlockScreen';
import { SetupPage } from './components/device/SetupScreens';
import { T } from './lib/device-texts';
import { SetupDriver } from './lib/setup-driver';
import { fakeClient } from './lib/device-test-kit';

// The top bar and the update hooks read the browser's localStorage and the network: not what is under test.
vi.mock('./components/TopNav', () => ({ TopNav: () => <nav data-stub="top-nav" /> }));
vi.mock('./components/UpdateBanner', () => ({ UpdateBanner: () => null }));
vi.mock('./components/SimulationBanner', () => ({ SimulationBanner: () => null }));
vi.mock('./hooks/useUpdateCheck', () => ({ useUpdateCheck: () => ({ serverRestarted: false, updateAvailable: false, installMethod: 'dev', version: '', latestVersion: null, startFastPolling: () => {}, dismiss: () => {} }) }));

// The other pages are not under test here and are heavy to load: the routes only need them to exist.
vi.mock('./components/AppShell', () => ({ AppShell: () => null }));
vi.mock('./pages/OnboardingPage', () => ({ OnboardingPage: () => null }));
vi.mock('./pages/DashboardPage', () => ({ DashboardPage: () => null }));
vi.mock('./pages/GateWizardPage', () => ({ GateWizardPage: () => null }));
vi.mock('./pages/AgentReviewPage', () => ({ AgentReviewPage: () => null }));
vi.mock('./pages/IntegrationsPage', () => ({ IntegrationsPage: () => null }));
vi.mock('./pages/GroupsPage', () => ({ GroupsPage: () => null }));
vi.mock('./pages/AuthorizationsPage', () => ({ AuthorizationsPage: () => null }));
vi.mock('./pages/AuditPage', () => ({ AuditPage: () => null }));
vi.mock('./pages/BlockedPage', () => ({ BlockedPage: () => null }));
vi.mock('./pages/SettingsServicesPage', () => ({ SettingsServicesPage: () => null }));
vi.mock('./pages/ProposalReviewPage', () => ({ ProposalReviewPage: () => null }));
vi.mock('./pages/AgentBriefPage', () => ({ AgentBriefPage: () => null }));
vi.mock('./pages/ReportsPage', () => ({ ReportsPage: () => null }));
vi.mock('./contexts/EventSourceContext', () => ({ EventSourceProvider: ({ children }: { children: unknown }) => children, useSSEEvent: () => {} }));

const auth = (over: Partial<AuthContextValue> = {}): AuthContextValue => ({
  user: null, access: 'legacy', deviceKeysSwitch: false, passwordSet: false, pageSessionOpen: false, sessionEnd: null,
  refreshAccess: async () => ({ access: 'legacy', switchOn: false, passwordSet: false }), openPageSession: () => {}, adoptSessionUser: async () => true, clearSessionEnd: () => {},
  mode: 'personal', group: null, domain: '', groupId: null, activeTeam: null, activeMembership: null, pendingRequest: null,
  isLoading: false, error: '', login: async () => {}, logout: async () => {}, clearError: () => {}, handleSessionLocked: () => {},
  activeGroup: null, activeDomain: '', groups: [], setActiveContext: () => {}, refreshGroups: async () => {},
  ...over,
});
const at = (path: string, el: ReactElement, over?: Partial<AuthContextValue>) =>
  renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><AuthContext.Provider value={auth(over)}>{el}</AuthContext.Provider></MemoryRouter>);

describe('AppRoutes wiring: which page /login shows (fix 1)', () => {
  it('legacy, switch off: the account-key sign-in at once', () => {
    for (const over of [{ access: 'legacy' as const, deviceKeysSwitch: false }]) {
      const h = at('/login', <AppRoutes />, over);
      expect(h).toContain('Enter your API key to manage mandates.');
      expect(h).not.toContain(T.unlockTitle);
      expect(h).not.toContain('device-screen');
    }
  });
  it('switch on without a password: nothing until the gateway says whether it is new (no flash of the sign-in before /start)', () => {
    const h = at('/login', <AppRoutes />, { access: 'legacy', deviceKeysSwitch: true, passwordSet: false });
    expect(h).not.toContain('Enter your API key');
    expect(h).toContain('brand-spin');
  });
  it('a password: the unlock screen, not the account-key form', () => {
    const h = at('/login', <AppRoutes />, { access: 'password', deviceKeysSwitch: true, passwordSet: true });
    expect(h).toContain(T.unlockTitle);
    expect(h).not.toContain('Enter your API key');
  });
  it('before the gateway has answered: neither page (no flash of the wrong one)', () => {
    const h = at('/login', <AppRoutes />, { access: null });
    expect(h).not.toContain('Enter your API key');
    expect(h).not.toContain(T.unlockTitle);
  });
  it('the set-up routes need a signed-in person on a password gateway', () => {
    for (const path of ['/device-setup', '/device-recovery-code', '/device-password']) {
      const h = at(path, <AppRoutes />, { user: null, access: 'legacy' });
      expect(h).not.toContain(T.nameTitle);
      expect(h).not.toContain(T.passwordTitle);
    }
  });
});

describe('UnlockPage and SetupPage, first render', () => {
  it('UnlockPage: the unlock form, with the reason the page closed when there is one', () => {
    const h = at('/login', <UnlockPage />, { access: 'password', sessionEnd: 'session_idle' });
    expect(h).toContain(T.unlockTitle);
    expect(h).toContain(T.sessionIdle);
    expect(at('/login', <UnlockPage />, { access: 'password' })).toContain(T.unlockWhy);
  });
  it('SetupPage: first render asks no name (DEC-91); the set-up then begins by itself', () => {
    const h = at('/device-setup', <SetupPage />, { access: 'password', pageSessionOpen: true });
    expect(h).toContain(T.nameTitle);
    expect(h).not.toContain(T.nameLabel);
    expect(h).not.toContain('<input');
  });
});

describe('guards on the wiring (no DOM is available in this suite, so effects cannot run: these read the code)', () => {
  const dir = join(__dirname, 'components', 'device');
  const sources = readdirSync(dir).filter(f => f.endsWith('.tsx') && !f.endsWith('.test.tsx')).map(f => [f, readFileSync(join(dir, f), 'utf8')] as const);

  it('3: no device screen reloads or leaves the page: a page load drops the in-memory page session', () => {
    for (const [f, src] of sources) {
      expect(src, f).not.toMatch(/location\.(assign|replace|reload)\(|location\.href\s*=/);
    }
  });
  it('3: after a recovery or a replacement, Continue navigates inside the app', () => {
    const src = readFileSync(join(dir, 'RecoverScreens.tsx'), 'utf8');
    expect(src).toMatch(/useNavigate\(\)/);
    expect(src).toMatch(/onDone=\{\(\) => navigate\('\/', \{ replace: true \}\)\}/);
  });
  it('5: the set-up driver is built from [client] only and reads the check key from a ref at call time', () => {
    const src = readFileSync(join(dir, 'SetupScreens.tsx'), 'utf8');
    expect(src).toMatch(/wantCheckKey: \(\) => wantCheckKey\.current \}\), \[client\]\)/);
    expect(src).not.toMatch(/useState\(false\);\s*\n\s*const driver/);
  });
  it('DEC-91: the set-up begins by itself, after the check-key answer, once, and not in the dev double mount', () => {
    const src = readFileSync(join(dir, 'SetupScreens.tsx'), 'utf8');
    const body = src.slice(src.indexOf('export function SetupPage'));
    const yieldAt = body.indexOf('await Promise.resolve();');
    const capsAt = body.indexOf('await client.platformCapabilities()');
    const resumeAt = body.indexOf('await driver.resume()');
    expect(yieldAt).toBeGreaterThan(-1);
    expect(capsAt).toBeGreaterThan(yieldAt);
    expect(resumeAt).toBeGreaterThan(capsAt);
    expect(body).toMatch(/if \(!live\) return;/);
    expect(body).toMatch(/\}, \[driver, client\]\);/);
  });
  it('a way into the device-key set-up always exists: team onboarding yields to the password offer; the card shows the next step', () => {
    const app = readFileSync(join(__dirname, 'App.tsx'), 'utf8');
    expect(app).toMatch(/offer \? '\/device-password' : '\/onboarding'/);
    const card = readFileSync(join(dir, 'DeviceKeysCard.tsx'), 'utf8');
    expect(card).toMatch(/if \(!passwordSet\)[\s\S]{0,200}to="\/device-password"/);
    expect(card).toMatch(/if \(!setUp\)[\s\S]{0,200}to="\/device-setup"/);
  });
  it('DEC-93: a new gateway starts at /start; set-up opens with the page session alone; the start token stays out of the page session', () => {
    const app = readFileSync(join(__dirname, 'App.tsx'), 'utf8');
    expect(app).toMatch(/path="\/start" element=\{user \? <Navigate to="\/" replace \/> : <StartPage \/>\}/);
    expect(app).toMatch(/<LoginOrStart switchOn=\{deviceKeysSwitch\}><LoginPage \/><\/LoginOrStart>/);
    expect(app).toMatch(/path="\/device-setup" element=\{\(user \|\| pageSessionOpen\) && access === 'password'/);
    const start = readFileSync(join(dir, 'StartScreens.tsx'), 'utf8');
    // Only the start routes carry the start token; it is never stored (no storage API, only a ref).
    expect(start).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    expect(start).toMatch(/const token = useRef<string \| null>\(null\)/);
    expect(start).toMatch(/turnOnTouchUnlock\(deviceClient, password\)/);
  });
  it('9: the unlock driver is built once (a ref), not in a memo that the auth context can rebuild', () => {
    const src = readFileSync(join(dir, 'UnlockScreen.tsx'), 'utf8');
    expect(src).toMatch(/driverRef = useRef<UnlockDriver \| null>\(null\)/);
    expect(src).not.toMatch(/new UnlockDriver[\s\S]{0,40}useMemo|useMemo\(\(\) => new UnlockDriver/);
    expect(src).not.toMatch(/driver\.afterSession\(\)\s*;?\s*\}, \[pageSessionOpen/);
  });
  it('5, behaviour: a driver whose check-key answer arrives later keeps the set-up it started', async () => {
    let want = false;
    const { client } = fakeClient({ '/auth/device/setup/start': { body: { setupId: 's', recoveryCode: 'C' } } });
    const d = new SetupDriver({ client, open: vi.fn(), wantCheckKey: () => want });
    await d.begin();
    want = true;
    expect(d.get().step).toBe('connect');
    expect(d.recoveryCode()).toBe('C');
  });
});
