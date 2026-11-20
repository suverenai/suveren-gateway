/**
 * The phone app (stage D1: register or join, device list, add a computer, read requests). The logic lives in the drivers and the
 * session (lib/); this file only decides which screen is on and starts the timers. One card for every device: the request is
 * drawn by the shared approval card (packages/approval-card), configured in lib/app-host.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Proposal } from '@suveren/approval-card/types';
import { BUILD_COMMIT, PHONE_FIRST_SETUP } from './lib/config';
import { createRuntime } from './lib/runtime';
import { assess, probe, requestPersistentStorage, type Need } from './lib/compat';
import { RegisterDriver } from './lib/register-driver';
import { JoinDriver } from './lib/join-driver';
import { AdmitDriver } from './lib/admit-driver';
import { deviceRows, type DeviceRow } from './lib/chain-view';
import { identityCodeOf } from './lib/identity-code';
import { bindPhoneHost } from './lib/app-host';
import { checkCard, type CardCheck } from './lib/card-checks';
import { DecideError } from './lib/decide';
import type { DecideArgs } from '@suveren/approval-card/components/ApprovalCard';
import { ThemeToggle } from '@suveren/approval-card/components/ThemeToggle';
import { Tabs } from '@suveren/approval-card/components/Tabs';
import { P, errorText } from './texts';
import { NeedsScreen, WelcomeScreen } from './screens/Start';
import { RegisterScreen } from './screens/Register';
import { JoinScreen } from './screens/Join';
import { AdmitScreen } from './screens/Admit';
import { DevicesScreen } from './screens/Devices';
import { RequestsScreen, RequestDetail } from './screens/Requests';
import { OpenSessionScreen } from './screens/OpenSession';
import { useDriver } from './screens/Frame';

/** How often an open list is read again (a timer; it never counts as use of the session). */
const REFRESH_MS = 30_000;
/** How often a pairing's mailbox is read while it waits. */
const POLL_MS = 2_000;
const VERSION = '0.1.0';

type View =
  | { t: 'boot' }
  | { t: 'needs'; needs: Need[] }
  | { t: 'welcome' }
  | { t: 'register' }
  | { t: 'join' }
  | { t: 'locked'; error: string | null; ended: boolean; canForget: boolean }
  | { t: 'home'; tab: 'requests' | 'devices' | 'admit' };

/** The theme switch is the gateway's (shared `ThemeToggle`, `useTheme`: `data-theme` on <html>, system default, remembered in localStorage). */
export default function App() {
  return (
    <>
      <div className="ap-top"><ThemeToggle /></div>
      <Screens />
    </>
  );
}

function Screens() {
  const rt = useMemo(() => createRuntime(), []);
  const [view, setView] = useState<View>({ t: 'boot' });
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const [updated, setUpdated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [joinKey, setJoinKey] = useState(0);
  const viewRef = useRef(view);
  viewRef.current = view;

  // ─── start ────────────────────────────────────────────────────────────────────
  const locked = useCallback((error: string | null = null, ended = false, canForget = false) => {
    bindPhoneHost(null);
    setView({ t: 'locked', error, ended, canForget });
  }, []);

  useEffect(() => {
    void (async () => {
      const a = assess(await probe());
      if (!a.ok) { setView({ t: 'needs', needs: a.needs }); return; }
      setPersistent(await requestPersistentStorage());
      setUpdated(await rt.accounts.buildChanged(BUILD_COMMIT));
      try {
        // DEC-83: phone-first setup off: a phone that is not paired goes straight to adding itself to an account.
        setView((await rt.accounts.read()) ? { t: 'locked', error: null, ended: false, canForget: false } : PHONE_FIRST_SETUP ? { t: 'welcome' } : { t: 'join' });
      } catch {
        // A stored account that cannot be read is never "not paired".
        setView({ t: 'locked', error: errorText('generic'), ended: false, canForget: true });
      }
    })();
  }, [rt]);

  // Content is hidden when the app goes to the background, and a session ends after more than 5 minutes away (plan 8, DEC-24, 6.2).
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        document.body.classList.add('ap-blank');
        rt.session.noteBackground();
      } else {
        document.body.classList.remove('ap-blank');
        rt.session.noteForeground();
        if (viewRef.current.t === 'home' && !rt.session.bearer()) locked(null, true);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [rt, locked]);

  // The phone's own session limits (an hour of no use, 12 hours after the last check) are looked at on a slow timer.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (viewRef.current.t === 'home' && !rt.session.bearer()) locked(null, true);
    }, 15_000);
    return () => window.clearInterval(t);
  }, [rt, locked]);

  // ─── open a session ───────────────────────────────────────────────────────────
  const openSession = useCallback(async () => {
    setBusy(true);
    const r = await rt.session.open();
    setBusy(false);
    if (!r.ok) {
      locked(errorText(r.code), false, r.code === 'device_removed' || r.code === 'keys_missing');
      return;
    }
    const account = await rt.accounts.read();
    if (!account) { locked(errorText('not_paired')); return; }
    bindPhoneHost({ reader: rt.reader, keys: rt.keys, ownKeyId: account.key_id, userId: r.session.user.id });
    setView({ t: 'home', tab: 'requests' });
  }, [rt, locked]);

  const forget = useCallback(async () => {
    await rt.keys.deleteAll().catch(() => {});
    await rt.accounts.clear().catch(() => {});
    setView(PHONE_FIRST_SETUP ? { t: 'welcome' } : { t: 'join' });
  }, [rt]);

  switch (view.t) {
    case 'boot':
      return <div className="device-screen"><p role="status">{P.listLoading}</p></div>;
    case 'needs':
      return <NeedsScreen needs={view.needs} />;
    case 'welcome':
      return <WelcomeScreen onNew={() => setView({ t: 'register' })} onJoin={() => setView({ t: 'join' })} />;
    case 'register':
      return <RegisterFlow rt={rt} onBack={() => setView({ t: 'welcome' })} onDone={() => locked()} />;
    case 'join':
      return <JoinFlow key={joinKey} rt={rt} onBack={() => (PHONE_FIRST_SETUP ? setView({ t: 'welcome' }) : setJoinKey((k) => k + 1))} onDone={() => locked()} />;
    case 'locked':
      return <OpenSessionScreen busy={busy} error={view.error} ended={view.ended} onOpen={() => void openSession()} onForget={view.canForget ? () => void forget() : undefined} />;
    case 'home':
      return <Home rt={rt} tab={view.tab} setTab={(tab) => setView({ t: 'home', tab })} persistent={persistent} updated={updated} onEnded={() => locked(null, true)} />;
  }
}

type Rt = ReturnType<typeof createRuntime>;

function RegisterFlow({ rt, onBack, onDone }: { rt: Rt; onBack: () => void; onDone: () => void }) {
  const driver = useMemo(() => new RegisterDriver({
    keys: rt.keys, check: rt.check, transport: rt.transport, api: rt.api, accounts: rt.accounts, asUrl: rt.asUrl, rpId: rt.rpId, now: rt.now,
  }), [rt]);
  useEffect(() => () => driver.dispose(), [driver]);
  const state = useDriver(driver);
  return (
    <RegisterScreen
      state={state} code={driver.recoveryCode()}
      onCode={(t) => void driver.submitCode(t)} onName={(l) => void driver.submitName(l)} onCodeSeen={() => driver.codeSeen()}
      onKept={(c) => driver.toggleKept(c)} onFinish={() => void driver.finish()}
      onCancel={() => { driver.cancel(); onBack(); }} onDone={onDone}
    />
  );
}

function JoinFlow({ rt, onBack, onDone }: { rt: Rt; onBack: () => void; onDone: () => void }) {
  const driver = useMemo(() => new JoinDriver({ keys: rt.keys, check: rt.check, transport: rt.transport, api: rt.api, accounts: rt.accounts, asUrl: rt.asUrl, now: rt.now }), [rt]);
  useEffect(() => () => driver.dispose(), [driver]);
  const state = useDriver(driver);
  useEffect(() => {
    const t = window.setInterval(() => void driver.poll(), POLL_MS);
    return () => window.clearInterval(t);
  }, [driver]);
  return (
    <JoinScreen
      state={state} nowSeconds={rt.now()}
      onScanned={(t) => void driver.scanned(t)} onReviewConfirm={() => driver.confirmReview()} onName={(l) => void driver.submitName(l)}
      onCancel={() => { void driver.cancel(); onBack(); }} onDone={onDone} canGoBack={PHONE_FIRST_SETUP}
    />
  );
}

function Home({ rt, tab, setTab, persistent, updated, onEnded }: {
  rt: Rt; tab: 'requests' | 'devices' | 'admit'; setTab: (t: 'requests' | 'devices' | 'admit') => void;
  persistent: boolean | null; updated: boolean; onEnded: () => void;
}) {
  return (
    <div className="ap-shell">
      <Tabs label="App" value={tab === 'requests' ? 'requests' : 'devices'} onChange={(t) => setTab(t)}
        items={[{ id: 'requests', label: P.navRequests }, { id: 'devices', label: P.navDevices }]} />
      {tab === 'requests' && <Requests rt={rt} onEnded={onEnded} />}
      {tab === 'devices' && <Devices rt={rt} persistent={persistent} updated={updated} onAdd={() => setTab('admit')} onEnded={onEnded} />}
      {tab === 'admit' && <AdmitFlow rt={rt} onDone={() => setTab('devices')} />}
    </div>
  );
}

function Requests({ rt, onEnded }: { rt: Rt; onEnded: () => void }) {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [open, setOpen] = useState<{ proposal: Proposal; check: CardCheck | null } | null>(null);

  const load = useCallback(async (byPerson: boolean) => {
    const r = await rt.reader.list(byPerson);
    if (r.ok) { setProposals(r.data); setError(undefined); return; }
    if (r.code === 'session_ended') { onEnded(); return; }
    setError(r.code === 'as_unreachable' ? errorText('as_unreachable') : P.listFailed);
  }, [rt, onEnded]);

  useEffect(() => {
    void load(true);
    const t = window.setInterval(() => void load(false), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const openOne = useCallback(async (id: string) => {
    const r = await rt.reader.get(id, true);
    if (!r.ok) { if (r.code === 'session_ended') onEnded(); else setError(P.listFailed); return; }
    // The card is drawn at once WITHOUT buttons; they come only when every check before a decision passed (lib/card-checks.ts).
    setOpen({ proposal: r.data, check: null });
    const check = await checkCard(rt.checks, r.data);
    if (!check.ok && check.reason === 'session_ended') { onEnded(); return; }
    setOpen((cur) => (cur && cur.proposal.id === id ? { proposal: cur.proposal, check } : cur));
  }, [rt, onEnded]);

  // The one place a button becomes a signed decision. The decider reads the request again and signs; a session over its limit asks for the touch first.
  const decide = useCallback(async (args: DecideArgs) => {
    const cur = open;
    if (!cur || !cur.check || !cur.check.ok) throw new DecideError('generic');
    if (args.kind === 'change') throw new DecideError('generic');
    return rt.decider.decide(cur.proposal, cur.check.ready, args.kind, { shownHash: args.shownHash });
  }, [rt, open]);

  if (open) {
    return (
      <RequestDetail
        proposal={open.proposal} userId={rt.session.current()?.user.id ?? ''} check={open.check} decide={decide}
        onBack={() => { setOpen(null); void load(true); }} onDecided={() => void load(true)}
      />
    );
  }
  return <RequestsScreen proposals={proposals} error={error} nowMs={Date.now()} onOpen={(id) => void openOne(id)} onRefresh={() => void load(true)} />;
}

function Devices({ rt, persistent, updated, onAdd, onEnded }: { rt: Rt; persistent: boolean | null; updated: boolean; onAdd: () => void; onEnded: () => void }) {
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const show = useCallback(async () => {
    const s = rt.session.current();
    const account = await rt.accounts.read();
    if (!s || !account) { onEnded(); return; }
    setRows(deviceRows(s.entries, s.chain, account.key_id, rt.now()));
    setCode(await identityCodeOf(account.root_did));
  }, [rt, onEnded]);

  const refresh = useCallback(async () => {
    setBusy(true);
    rt.session.noteUse();
    const r = await rt.session.refreshChain();
    setBusy(false);
    if (!r.ok) { setError(errorText(r.code)); return; }
    setError(undefined);
    await show();
  }, [rt, show]);

  useEffect(() => { void show(); void refresh(); }, [show, refresh]);

  return (
    <DevicesScreen
      rows={rows} identityCode={code} nowSeconds={rt.now()} persistent={persistent} updated={updated}
      version={VERSION} build={BUILD_COMMIT} onAddComputer={onAdd} onRefresh={() => void refresh()} busy={busy} error={error}
    />
  );
}

function AdmitFlow({ rt, onDone }: { rt: Rt; onDone: () => void }) {
  const driver = useMemo(() => new AdmitDriver({ keys: rt.keys, check: rt.check, api: rt.api, accounts: rt.accounts, session: rt.session, now: rt.now }), [rt]);
  useEffect(() => () => driver.dispose(), [driver]);
  const state = useDriver(driver);
  useEffect(() => {
    const t = window.setInterval(() => void driver.poll(), POLL_MS);
    return () => window.clearInterval(t);
  }, [driver]);
  return (
    <AdmitScreen
      state={state} nowSeconds={rt.now()}
      onScanned={(t) => void driver.scanned(t)} onChoose={(c) => void driver.choose(c)}
      onCancel={() => driver.cancel()} onDone={onDone}
    />
  );
}
