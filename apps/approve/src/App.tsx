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
import { DevicesScreen, RemoveScreen } from './screens/Devices';
import { RemoveDriver } from './lib/remove-driver';
import { RotateDriver, codeMadeOn, rotateOffered } from './lib/rotate-driver';
import { RotateScreen } from './screens/Rotate';
import { chainNotices, type ChainNotice } from './lib/chain-notices';
import { whenText } from './screens/Frame';
import { RequestsScreen } from './screens/Requests';
import { RequestPanel } from './screens/RequestPanel';
import { loadAutoOpen, saveAutoOpen } from './lib/panel-setting';
import {
  INITIAL_PANEL, RESULT_SHOW_MS, afterDecision, neighbour, panelChrome, positionOf, reconcilePanel, resolveCurrent, type PanelState,
} from '@suveren/approval-card/lib/approval-panel';
import { resultDismissLabel, type ApprovalOutcome } from '@suveren/approval-card/lib/approval-outcome';
import { OpenSessionScreen } from './screens/OpenSession';
import { GiveDriver, readGives, type GiveItem } from './lib/mandate-give';
import { EndDriver, readOwnMandates, type OwnMandate } from './lib/mandate-end';
import { GiveCard, GiveRow, OwnMandates, EndScreen } from './screens/Mandates';
import { Notice } from './screens/Frame';
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
  | { t: 'join'; notice?: string }
  | { t: 'locked'; error: string | null; ended: boolean; canForget: boolean }
  | { t: 'home'; tab: 'requests' | 'devices' | 'admit'; rotate?: boolean };

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
  const rotateNext = useRef(false);

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

  const forgetTo = useCallback(async (notice?: string) => {
    bindPhoneHost(null);
    await rt.session.end().catch(() => {});
    await rt.keys.deleteAll().catch(() => {});
    await rt.accounts.clear().catch(() => {});
    setView(PHONE_FIRST_SETUP && !notice ? { t: 'welcome' } : { t: 'join', notice });
  }, [rt]);
  const forget = useCallback(async () => { await forgetTo(); }, [forgetTo]);

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
    // "Make a new code" on the join's done screen (mockup D1): straight to replacing the recovery code once the app is open.
    if (rotateNext.current) { rotateNext.current = false; setView({ t: 'home', tab: 'devices', rotate: true }); return; }
    setView({ t: 'home', tab: 'requests' });
  }, [rt, locked]);



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
      return <JoinFlow key={joinKey} rt={rt} notice={view.notice} onBack={() => (PHONE_FIRST_SETUP ? setView({ t: 'welcome' }) : setJoinKey((k) => k + 1))} onDone={() => locked()} onRotate={() => { rotateNext.current = true; locked(); }} />;
    case 'locked':
      return <OpenSessionScreen busy={busy} error={view.error} ended={view.ended} onOpen={() => void openSession()} onForget={view.canForget ? () => void forget() : undefined} />;
    case 'home':
      return <Home rt={rt} tab={view.tab} rotate={view.rotate} setTab={(tab) => setView({ t: 'home', tab })} persistent={persistent} updated={updated} onEnded={() => locked(null, true)} onRemovedSelf={() => void forgetTo(P.removedSelf)} />;
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

function JoinFlow({ rt, notice, onBack, onDone, onRotate }: { rt: Rt; notice?: string; onBack: () => void; onDone: () => void; onRotate: () => void }) {
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
      onCancel={() => { void driver.cancel(); onBack(); }} onDone={onDone} canGoBack={PHONE_FIRST_SETUP} notice={notice} onRotate={onRotate}
    />
  );
}

function Home({ rt, tab, rotate, setTab, persistent, updated, onEnded, onRemovedSelf }: {
  rt: Rt; tab: 'requests' | 'devices' | 'admit'; rotate?: boolean; setTab: (t: 'requests' | 'devices' | 'admit') => void;
  persistent: boolean | null; updated: boolean; onEnded: () => void; onRemovedSelf: () => void;
}) {
  // While a touch signs a device change, nothing navigates away (UI review: nav locked during signing).
  const [locked, setLocked] = useState(false);
  return (
    <div className="ap-shell">
      <div {...(locked ? { inert: '', 'aria-disabled': true } : {})} data-testid="app-nav">
        <Tabs label="App" value={tab === 'requests' ? 'requests' : 'devices'} onChange={(t) => { if (!locked) setTab(t); }}
          items={[{ id: 'requests', label: P.navRequests }, { id: 'devices', label: P.navDevices }]} />
      </div>
      {tab === 'requests' && <Requests rt={rt} onEnded={onEnded} />}
      {tab === 'devices' && <Devices rt={rt} persistent={persistent} updated={updated} onAdd={() => setTab('admit')} onEnded={onEnded} onRemovedSelf={onRemovedSelf} startRotate={rotate} onLockChange={setLocked} />}
      {tab === 'admit' && <AdmitFlow rt={rt} onDone={() => setTab('devices')} />}
    </div>
  );
}

interface OpenCard { proposal: Proposal; check: CardCheck | null }

/**
 * The requests: the list, and the panel that opens a waiting approval full screen by itself (DEC-86, the gateway's mechanism). The
 * rules are the shared ones (approval-panel.ts of the package): an arrival opens the panel when the setting is on; Later sends it
 * back to the list; a decision's result stays on the card for the gateway's time (or until Next / Close when it was refused or is
 * not known), then the next one opens or the panel closes.
 */
function Requests({ rt, onEnded }: { rt: Rt; onEnded: () => void }) {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [autoOpen, setAutoOpenState] = useState<boolean | null>(null);
  const [settingRead, setSettingRead] = useState(false);
  const [panel, setPanel] = useState<PanelState>(INITIAL_PANEL);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [settling, setSettling] = useState<{ id: string; before: string[]; stay: boolean } | null>(null);
  const settlingRef = useRef<{ id: string; before: string[] } | null>(null);
  const [cards, setCards] = useState<Record<string, OpenCard>>({});
  const [busy, setBusy] = useState(false);
  const timers = useRef<number[]>([]);
  // D3: mandates to give (prepared on a computer), this person's own mandates (End), and notices of gives made on other devices.
  const [gives, setGives] = useState<GiveItem[]>([]);
  const [own, setOwn] = useState<OwnMandate[]>([]);
  const giver = useMemo(() => new GiveDriver({ keys: rt.keys, check: rt.check, api: rt.api, accounts: rt.accounts, session: rt.session, now: rt.now }), [rt]);
  const giving = useDriver(giver);
  const ender = useMemo(() => new EndDriver({ keys: rt.keys, api: rt.api, accounts: rt.accounts, session: rt.session, now: rt.now }), [rt]);
  const ending = useDriver(ender);
  const giveBusy = giving.step === 'checking' || giving.step === 'sending';
  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); }, []);

  const loadMandates = useCallback(async () => {
    const g = await readGives(rt);
    if (g.ok) setGives(g.items); else if (g.code === 'session_ended') { onEnded(); return; }
    const m = await readOwnMandates(rt);
    if (m.ok) setOwn(m.items);
  }, [rt, onEnded]);

  const load = useCallback(async (byPerson: boolean) => {
    void loadMandates();
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

  useEffect(() => {
    void loadAutoOpen(rt.kv).then((v) => { setAutoOpenState(v); setSettingRead(true); });
  }, [rt]);

  // The panel's order is the gateway's: oldest first. The list screen shows newest first.
  const ids = useMemo(() => [
    ...gives.map((g) => g.key),
    ...[...(proposals ?? [])].sort((a, b) => a.createdAt - b.createdAt).map((p) => p.id),
  ], [proposals, gives]);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const hold = settling !== null;
  const idsKey = ids.join('\u0001');
  useEffect(() => {
    setPanel((prev) => reconcilePanel(prev, {
      ids: idsRef.current, loaded: proposals !== null && settingRead, autoOpen, typing: false, onApprovalsPage: false, hold,
    }));
  }, [idsKey, proposals, settingRead, autoOpen, hold]);

  const chrome = panelChrome({ count: ids.length, open: panel.open, typing: false, onApprovalsPage: false, hold });
  const showId = resolveCurrent(ids, currentId);
  const shownId = settling?.id ?? showId;

  // The card on screen is read fresh and checked; the buttons come only when every check passed (lib/card-checks.ts).
  const openCard = useCallback(async (id: string) => {
    const r = await rt.reader.get(id, true);
    if (!r.ok) { if (r.code === 'session_ended') onEnded(); else setError(P.listFailed); return; }
    setCards((c) => ({ ...c, [id]: { proposal: r.data, check: null } }));
    const check = await checkCard(rt.checks, r.data);
    if (!check.ok && check.reason === 'session_ended') { onEnded(); return; }
    setCards((c) => (c[id] ? { ...c, [id]: { proposal: c[id].proposal, check } } : c));
  }, [rt, onEnded]);

  const shownCard = shownId ? cards[shownId] : undefined;
  useEffect(() => {
    if (chrome.panel && shownId && !shownId.startsWith('give:') && !cards[shownId]) void openCard(shownId);
  }, [chrome.panel, shownId, cards, openCard]);

  const shownGive = shownId && shownId.startsWith('give:') ? gives.find((g) => g.key === shownId) ?? null : null;
  useEffect(() => {
    const cur = giving.step !== 'idle' ? giving.item : null;
    if (shownGive && (!cur || cur.key !== shownGive.key) && !settling) giver.open(shownGive);
  }, [shownGive, giving, giver, settling]);
  // The give's own result decides like a decision does (the shared panel rules): Signed times away; not received stays.
  useEffect(() => {
    if (giving.step === 'signed' && settlingRef.current?.id !== giving.item.key) {
      settlingRef.current = { id: giving.item.key, before: idsRef.current };
      setSettling({ id: giving.item.key, before: idsRef.current, stay: false });
      const key = giving.item.key;
      timers.current.push(window.setTimeout(() => { finishSettlingRef.current(key); void loadMandates(); }, RESULT_SHOW_MS));
    }
    if (giving.step === 'not_received' && settlingRef.current?.id !== giving.item.key) {
      settlingRef.current = { id: giving.item.key, before: idsRef.current };
      setSettling({ id: giving.item.key, before: idsRef.current, stay: true });
    }
  }, [giving, loadMandates]);
  useEffect(() => { setBusy(giveBusy); }, [giveBusy]);

  const later = useCallback(() => {
    setPanel((p) => ({ ...p, open: false }));
    if (settlingRef.current) { settlingRef.current = null; setSettling(null); }
  }, []);

  const finishSettling = useCallback((id: string) => {
    const s = settlingRef.current;
    if (!s || s.id !== id) return;
    settlingRef.current = null;
    const { next } = afterDecision(s.before, id);
    setCards((c) => { const { [id]: _gone, ...rest } = c; return rest; });
    if (next) setCurrentId(next);
    else setPanel((p) => ({ ...p, open: false }));
    setSettling(null);
  }, []);

  const finishSettlingRef = useRef(finishSettling);
  finishSettlingRef.current = finishSettling;

  const handleDecided = useCallback((id: string) => {
    settlingRef.current = { id, before: idsRef.current };
    setSettling({ id, before: idsRef.current, stay: false });
    void load(true);
  }, [load]);

  const handleOutcome = useCallback((id: string, outcome: ApprovalOutcome) => {
    if (settlingRef.current?.id !== id) return;
    if (outcome === 'done') timers.current.push(window.setTimeout(() => finishSettling(id), RESULT_SHOW_MS));
    else if (outcome === 'refused' || outcome === 'unknown') setSettling((s) => (s && s.id === id ? { ...s, stay: true } : s));
  }, [finishSettling]);

  const toggleAuto = useCallback(() => {
    const value = autoOpen !== true;
    if (!value) later();
    void saveAutoOpen(rt.kv, value).then(setAutoOpenState, () => setAutoOpenState(null));
  }, [autoOpen, later, rt]);

  // The one place a button becomes a signed decision. The decider reads the request again and signs; a session over its limit asks for the touch first.
  const decideFor = useCallback((id: string) => async (args: DecideArgs) => {
    const cur = cards[id];
    if (!cur || !cur.check || !cur.check.ok) throw new DecideError('generic');
    if (args.kind === 'change') throw new DecideError('generic');
    return rt.decider.decide(cur.proposal, cur.check.ready, args.kind, { shownHash: args.shownHash });
  }, [rt, cards]);

  // What opens after a decided card: named on its result while it waits (UI review, DEC-88; the gateway's rule).
  const nextProposalOf = (before: string[], id: string) => {
    const n = afterDecision(before, id).next;
    return n ? (proposals ?? []).find((p) => p.id === n) ?? null : null;
  };
  if (chrome.panel) {
    const before = settling ? settling.before : ids;
    const pos = positionOf(before, shownId);
    return (
      <RequestPanel
        position={pos}
        total={before.length}
        prevId={settling || busy ? null : neighbour(ids, showId, -1)}
        nextId={settling || busy ? null : neighbour(ids, showId, 1)}
        onMove={setCurrentId}
        onLater={later}
        autoOpen={autoOpen}
        onToggleAuto={toggleAuto}
        locked={busy}
        error={error}
        other={shownId && shownId.startsWith('give:') && giving.step !== 'idle' && giving.item?.key === shownId ? {
          key: shownId,
          node: (
            <GiveCard
              state={giving} nowSeconds={rt.now()}
              onGive={() => void giver.give()} onLater={later} onCancelTouch={() => giver.cancelTouch()}
              onCheckAgain={() => void giver.checkAgain()}
              onDone={() => { const k = shownId; giver.close(); finishSettling(k); void loadMandates(); }}
              dismissLabel={resultDismissLabel(afterDecision(settling ? settling.before : ids, shownId).next !== null)}
            />
          ),
        } : null}
        shown={shownId && shownCard ? {
          proposal: shownCard.proposal,
          card: {
            userId: rt.session.current()?.user.id ?? '',
            check: shownCard.check,
            decide: decideFor(shownId),
            onDecided: () => handleDecided(shownId),
            onBusyChange: setBusy,
            onOutcome: (o) => handleOutcome(shownId, o),
            nextProposal: settling && settling.id === shownId ? nextProposalOf(settling.before, shownId) : null,
            ...(settling?.stay && settling.id === shownId ? {
              dismissLabel: resultDismissLabel(afterDecision(settling.before, shownId).next !== null),
              onDismissResult: () => finishSettling(shownId),
            } : {}),
          },
        } : null}
      />
    );
  }
  if (ending.step !== 'idle') {
    return (
      <EndScreen
        state={ending} onEnd={() => void ender.end()} onKeep={() => ender.close()}
        onDone={() => { ender.close(); void loadMandates(); }}
      />
    );
  }
  const now = rt.now();
  const notices = own.filter((m) => m.givenOn && m.givenAt !== null && now - (m.givenAt ?? 0) < 14 * 86400).map((m) => P.noticeGiven(m.title, m.givenOn!));
  return (
    <RequestsScreen
      extra={(
        <>
          {notices.map((n) => <Notice key={n} kind="info">{n}</Notice>)}
          {gives.length > 0 && (
            <div className="dash-rows" data-testid="give-list">
              {gives.map((g) => <GiveRow key={g.key} item={g} nowSeconds={now} onOpen={() => { setCurrentId(g.key); setPanel((p) => ({ ...p, open: true, owed: false })); }} />)}
            </div>
          )}
          <OwnMandates items={own} nowSeconds={now} onEnd={(m) => ender.open(m)} />
        </>
      )}
      proposals={proposals} error={error} nowMs={Date.now()}
      onOpen={(id) => { setCurrentId(id); setPanel((p) => ({ ...p, open: true, owed: false })); }}
      onRefresh={() => void load(true)}
    />
  );
}

function Devices({ rt, persistent, updated, onAdd, onEnded, onRemovedSelf, startRotate, onLockChange }: {
  rt: Rt; persistent: boolean | null; updated: boolean; onAdd: () => void; onEnded: () => void; onRemovedSelf: () => void; startRotate?: boolean;
  onLockChange: (locked: boolean) => void;
}) {
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const remover = useMemo(() => new RemoveDriver({ keys: rt.keys, check: rt.check, api: rt.api, accounts: rt.accounts, session: rt.session, now: rt.now }), [rt]);
  const removing = useDriver(remover);
  const rotator = useMemo(() => new RotateDriver({ keys: rt.keys, check: rt.check, api: rt.api, accounts: rt.accounts, session: rt.session, now: rt.now }), [rt]);
  const rotating = useDriver(rotator);
  const [offer, setOffer] = useState<string | null>(null);
  // While the email link is out, the chain is read again until the entry is in it.
  useEffect(() => {
    if (rotating.step !== 'waiting') return undefined;
    const t = window.setInterval(() => void rotator.poll(), POLL_MS);
    return () => window.clearInterval(t);
  }, [rotator, rotating.step]);
  // Signing (the touch is out, nothing sent yet): the tabs are locked until it is done, failed or cancelled.
  const signing = (removing.step === 'checking' && !removing.error) || removing.step === 'sending'
    || (rotating.step === 'checking' && !rotating.error) || rotating.step === 'sending';
  useEffect(() => { onLockChange(signing); }, [signing, onLockChange]);
  useEffect(() => () => onLockChange(false), [onLockChange]);
  // Started from the join's done screen ("Make a new code", mockup D1).
  useEffect(() => { if (startRotate) rotator.start(); }, [rotator, startRotate]);

  const show = useCallback(async () => {
    const s = rt.session.current();
    const account = await rt.accounts.read();
    if (!s || !account) { onEnded(); return; }
    const now = rt.now();
    setRows(deviceRows(s.entries, s.chain, account.key_id, now));
    setNotices(chainNotices(s.entries, s.chain, account.key_id, now).map((n) => noticeText(n, now)));
    setOffer(rotateOffered(s.entries, s.chain, account.key_id) ? (codeMadeOn(s.entries, s.chain) ?? P.devKindComputer) : null);
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

  if (rotating.step !== 'idle') {
    return (
      <RotateScreen
        state={rotating}
        onOld={(c) => void rotator.submitOld(c)} onNew={(t) => void rotator.confirmNew(t)}
        onCancel={() => rotator.cancel()} onDone={() => { rotator.cancel(); void show(); }}
        onCancelTouch={() => rotator.cancelTouch()} onRetryTouch={() => void rotator.retryTouch()}
      />
    );
  }
  if (removing.step !== 'idle') {
    return (
      <RemoveScreen
        state={removing} nowSeconds={rt.now()}
        onConfirm={() => void remover.confirm()} onCancel={() => remover.cancel()} onCancelTouch={() => remover.cancelTouch()} onAdd={() => { remover.cancel(); onAdd(); }}
        onDone={() => {
          const self = removing.step === 'done' && removing.self;
          remover.cancel();
          if (self) onRemovedSelf(); else void show();
        }}
      />
    );
  }
  return (
    <DevicesScreen
      rows={rows} identityCode={code} nowSeconds={rt.now()} persistent={persistent} updated={updated}
      version={VERSION} build={BUILD_COMMIT} onAddComputer={onAdd} onRefresh={() => void refresh()} busy={busy} error={error}
      onRemove={(keyId) => void remover.start(keyId)} notices={notices}
      rotateOffer={offer} onRotate={() => rotator.start()}
    />
  );
}

/** A notice from the chain, in words (mockup F1, F3). */
function noticeText(n: ChainNotice, now: number): string {
  const by = n.by ?? P.noticeByCode;
  if (n.kind === 'added') return P.noticeAdded(n.label, whenText(n.at, now), by);
  if (n.kind === 'removed') return P.noticeRemoved(n.label, by);
  return P.noticeRotated(by);
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
