/**
 * The phone app (stage D1: register or join, device list, add a computer, read requests). The logic lives in the drivers and the
 * session (lib/); this file only decides which screen is on and starts the timers. One card for every device: the request is
 * drawn by the shared approval card (packages/approval-card), configured in lib/app-host.ts.
 */
import { LoadGate, Gated, SkelBlock, SkelButton, SkelLine, SkelTitle, SkelArea, useNetworkSettled } from '@suveren/approval-card/components/LoadGate';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { ChangeConfirmDriver, ChangeRequestReader, type ChangeItem } from './lib/change-requests';
import { ChangeCard, changeTitle, useNowSeconds } from './screens/ChangeCard';
import { GiveDriver, readGives, type GiveItem } from './lib/mandate-give';
import { EndDriver, readOwnMandates, type OwnMandate, type EndedElsewhere } from './lib/mandate-end';
import { GiveCard, GiveRow, OwnMandates, EndScreen } from './screens/Mandates';
import { Notice } from './screens/Frame';
import { useDriver } from './screens/Frame';
import { requestFromHash, type PushState } from './lib/push';
import { onForeground } from './lib/foreground';
import { readPendingPasskeys, approvePasskey, type PendingPasskey } from './lib/passkey-approve';
import { DashboardPasskeyCard, PASSKEY_TEXT, passkeyRefusalText, type PasskeyCardView } from '@suveren/approval-card/components/DashboardPasskeyCard';

/** How often an open list is read again (a timer; it never counts as use of the session). */
const REFRESH_MS = 30_000;
/** How often a pairing's mailbox is read while it waits. */
const POLL_MS = 2_000;
const VERSION = '0.1.0';

/** A request a notification asked to open (`#request=<id>` at start, or a message from the service worker): opened once the session is. */
type OpenRequest = { id: string; n: number } | null;

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
  const [openRequest, setOpenRequest] = useState<OpenRequest>(() => {
    const id = requestFromHash(globalThis.location?.hash ?? '');
    return id ? { id, n: 0 } : null;
  });

  // A tap on a notification while the app is open: the service worker focuses this window and names the request (stage D4).
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { t?: unknown; id?: unknown } | null;
      // A device notice: the list of devices is what changed (stage D4, device notices).
      if (d && d.t === 'open-devices') { if (viewRef.current.t === 'home') setView({ t: 'home', tab: 'devices' }); return; }
      if (!d || d.t !== 'open-request') return;
      const id = typeof d.id === 'string' ? requestFromHash(`#request=${d.id}`) : null;
      setOpenRequest((cur) => (id ? { id, n: (cur?.n ?? 0) + 1 } : null));
      if (viewRef.current.t === 'home') setView({ t: 'home', tab: 'requests' });
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, []);

  // ─── start ────────────────────────────────────────────────────────────────────
  const locked = useCallback((error: string | null = null, ended = false, canForget = false) => {
    bindPhoneHost(null);
    setView({ t: 'locked', error, ended, canForget });
  }, []);

  // While the open screen waits for the person's tap, the sign-in's first steps (the server's key, a fresh challenge) are fetched
  // already, so the Face ID / fingerprint prompt comes at once after the tap. Nothing is shown or decided before the check.
  useEffect(() => {
    if (view.t === 'locked' && !view.canForget) rt.session.prepare();
  }, [rt, view]);

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
    // Notifications that are on send their subscription again (renewed by the browser, or deleted after a 410). Quiet.
    const bearer = rt.session.bearer();
    if (bearer) void rt.push.resync(bearer);
    setView({ t: 'home', tab: 'requests' });
  }, [rt, locked]);



  switch (view.t) {
    case 'boot':
      // DEC-100: before the app knows which screen opens (welcome, open, requests), a screen greyed out, never a text.
      return (
        <div className="device-screen" data-testid="boot-skeleton">
          <SkelArea label={P.listLoading}>
            <SkelLine w="55%" h="1.6rem" style={{ marginBottom: '1rem' }} />
            <SkelLine w="90%" style={{ marginBottom: '0.5rem' }} />
            <SkelLine w="70%" style={{ marginBottom: '1.5rem' }} />
            <SkelButton full large />
          </SkelArea>
        </div>
      );
    case 'needs':
      return <NeedsScreen needs={view.needs} />;
    case 'welcome':
      return <WelcomeScreen onNew={() => setView({ t: 'register' })} onJoin={() => setView({ t: 'join' })} />;
    case 'register':
      return <RegisterFlow rt={rt} onBack={() => setView({ t: 'welcome' })} onDone={() => locked()} />;
    case 'join':
      return <JoinFlow key={joinKey} rt={rt} notice={view.notice} onBack={() => (PHONE_FIRST_SETUP ? setView({ t: 'welcome' }) : setJoinKey((k) => k + 1))} onDone={() => locked()} />;
    case 'locked':
      return <OpenSessionScreen busy={busy} error={view.error} ended={view.ended} onOpen={() => void openSession()} onForget={view.canForget ? () => void forget() : undefined} />;
    case 'home':
      return (
        <Home rt={rt} tab={view.tab} rotate={view.rotate} setTab={(tab) => setView({ t: 'home', tab })} persistent={persistent} updated={updated} onEnded={() => locked(null, true)} onRemovedSelf={() => void forgetTo(P.removedSelf)}
          openRequest={openRequest} onOpened={() => { setOpenRequest(null); if (globalThis.location?.hash) history.replaceState(null, '', ' '); }} />
      );
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

function JoinFlow({ rt, notice, onBack, onDone }: { rt: Rt; notice?: string; onBack: () => void; onDone: () => void }) {
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
      onCancel={() => { void driver.cancel(); onBack(); }} onDone={onDone} canGoBack={PHONE_FIRST_SETUP} notice={notice}
    />
  );
}

function Home({ rt, tab, rotate, setTab, persistent, updated, onEnded, onRemovedSelf, openRequest, onOpened }: {
  rt: Rt; tab: 'requests' | 'devices' | 'admit'; rotate?: boolean; setTab: (t: 'requests' | 'devices' | 'admit') => void;
  persistent: boolean | null; updated: boolean; onEnded: () => void; onRemovedSelf: () => void; openRequest: OpenRequest; onOpened: () => void;
}) {
  // While a touch signs a device change, nothing navigates away (UI review: nav locked during signing).
  const [locked, setLocked] = useState(false);
  return (
    <div className="ap-shell">
      <div {...(locked ? { inert: '', 'aria-disabled': true } : {})} data-testid="app-nav">
        <Tabs label="App" value={tab === 'requests' ? 'requests' : 'devices'} onChange={(t) => { if (!locked) setTab(t); }}
          items={[{ id: 'requests', label: P.navRequests }, { id: 'devices', label: P.navDevices }]} />
      </div>
      {tab === 'requests' && <Requests rt={rt} onEnded={onEnded} openRequest={openRequest} onOpened={onOpened} />}
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
function Requests({ rt, onEnded, openRequest, onOpened }: { rt: Rt; onEnded: () => void; openRequest: OpenRequest; onOpened: () => void }) {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [offer, setOffer] = useState<{ busy: boolean; error?: string } | null>(null);
  const [missed, setMissed] = useState(0);

  // The offer to turn notifications on: once the phone is in the account, until they are on or the person said "not now".
  useEffect(() => {
    void (async () => {
      if ((await rt.push.state()) === 'off' && !(await rt.push.offerDismissed())) setOffer({ busy: false });
    })();
  }, [rt]);

  const turnOn = useCallback(async () => {
    const bearer = rt.session.bearer();
    if (!bearer) { onEnded(); return; }
    rt.session.noteUse();
    setOffer({ busy: true });
    const r = await rt.push.turnOn(bearer);
    if (r.ok) { setOffer(null); return; }
    if (r.code === 'push_denied' || r.code === 'push_unsupported') await rt.push.dismissOffer();
    setOffer({ busy: false, error: errorText(r.code) });
  }, [rt, onEnded]);
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
  const [endedElsewhere, setEndedElsewhere] = useState<EndedElsewhere[]>([]);
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
    if (m.ok) { setOwn(m.items); setEndedElsewhere(m.ended); }
  }, [rt, onEnded]);

  // A computer's change requests waiting for this phone (stage D3): read and checked beside the proposals, in the same panel.
  const changeReader = useMemo(() => new ChangeRequestReader({ keys: rt.keys, api: rt.api, accounts: rt.accounts, session: rt.session, now: rt.now }), [rt]);
  const [changes, setChanges] = useState<ChangeItem[]>([]);
  const changesRef = useRef<ChangeItem[]>([]);
  changesRef.current = changes;

  const load = useCallback(async (byPerson: boolean) => {
    void loadMandates();
    const [r, c] = await Promise.all([rt.reader.list(byPerson), changeReader.list()]);
    if (c.ok) setChanges(c.items);
    if (r.ok) {
      setProposals(r.data);
      setError(undefined);
      const waiting = r.data.filter((x) => x.status === 'pending');
      setMissed(await rt.push.missed(waiting));
      // A notice never keeps counting what no longer waits (decided here or elsewhere): recorded for the worker, stale notice closed.
      void rt.push.settle(new Set(waiting.map((x) => x.id)));
      return;
    }
    if (r.code === 'session_ended') { onEnded(); return; }
    setError(r.code === 'as_unreachable' ? errorText('as_unreachable') : P.listFailed);
  }, [rt, onEnded, changeReader]);

  useEffect(() => {
    void load(true);
    const t = window.setInterval(() => void load(false), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  // The app comes to the front (from the background, from the app switcher, or opened again from the home screen): the list is read
  // at once, not at the next refresh (30 s). A session that ended while away is handled by the shell (it shows the open screen).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    // After the shell's own handler (it ends a session that was away more than 5 minutes): checked in a microtask, so a session
    // ended there is never used for this read; the open screen shows instead and reads after the check.
    return onForeground({ doc: document, win: window }, () => { queueMicrotask(() => { if (rt.session.bearer()) void load(false); }); });
  }, [rt, load]);

  // A push while the app is open: the service worker says so at once, and the list is read again now, not at the next refresh (30 s).
  // The request then opens by itself under the same rule as on the gateway page ("Open automatically").
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => { if ((e.data as { t?: unknown } | null)?.t === 'pushed') void load(false); };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, [load]);

  useEffect(() => {
    void loadAutoOpen(rt.kv).then((v) => { setAutoOpenState(v); setSettingRead(true); });
  }, [rt]);

  // A request a notification named: opened once in the panel (the gateway's mechanism), then forgotten. The list is read again so a
  // request that arrived with the notice is in it.
  // An AI-proposed mandate or change whose give the computer prepared for this phone: the give stands in the request's place (one item,
  // given with the touch). A give whose request is no longer waiting (given on the computer, rejected, run out) is not offered.
  const waitingIds = useMemo(() => new Set((proposals ?? []).filter((p) => p.status === 'pending').map((p) => p.id)), [proposals]);
  const shownGives = useMemo(() => gives.filter((g) => !g.proposalId || proposals === null || waitingIds.has(g.proposalId)), [gives, proposals, waitingIds]);
  const givenInPlace = useMemo(() => new Set(shownGives.map((g) => g.proposalId).filter((x): x is string => !!x)), [shownGives]);
  const listedProposals = useMemo(() => proposals === null ? null : proposals.filter((p) => !givenInPlace.has(p.id)), [proposals, givenInPlace]);

  const givesRef = useRef<GiveItem[]>([]);
  givesRef.current = shownGives;
  useEffect(() => {
    if (!openRequest) return;
    onOpened();
    // A notice names the AI's request; when its give is here, the give is what opens (it stands in the request's place).
    const inPlace = openRequest.id ? givesRef.current.find((g) => g.proposalId === openRequest.id) : undefined;
    setCurrentId(inPlace ? inPlace.key : openRequest.id);
    // The tapped request is read and checked at once, beside the list, not after it (the list read and the card's reads overlap).
    if (openRequest.id && !inPlace) void openCardRef.current(openRequest.id);
    setPanel((p) => ({ ...p, open: true, owed: false }));
    void load(true);
  }, [openRequest, onOpened, load]);

  // The panel's order is the gateway's: oldest first. The list screen shows newest first. A change request is `chg:<request id>`;
  // mandates to give (`give:<key>`) come first, as on the D3 mockup.
  const ids = useMemo(() => [
    ...shownGives.map((g) => g.key),
    ...[
      ...(listedProposals ?? []).map((p) => ({ id: p.id, at: p.createdAt })),
      ...changes.map((c) => ({ id: `${CHG}${c.requestId}`, at: c.createdAt })),
    ].sort((a, b) => a.at - b.at).map((x) => x.id),
  ], [listedProposals, changes, shownGives]);
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
  // One read per card at a time: the tapped request is read at once, and the panel would otherwise ask again before it lands.
  const reading = useRef(new Set<string>());
  const openCard = useCallback(async (id: string) => {
    if (reading.current.has(id)) return;
    reading.current.add(id);
    try { await readCard(id); } finally { reading.current.delete(id); }
  }, [rt, onEnded]); // eslint-disable-line react-hooks/exhaustive-deps
  const readCard = async (id: string) => {
    const r = await rt.reader.get(id, true);
    if (!r.ok) { if (r.code === 'session_ended') onEnded(); else setError(P.listFailed); return; }
    setCards((c) => ({ ...c, [id]: { proposal: r.data, check: null } }));
    const check = await checkCard(rt.checks, r.data);
    if (!check.ok && check.reason === 'session_ended') { onEnded(); return; }
    setCards((c) => (c[id] ? { ...c, [id]: { proposal: c[id].proposal, check } } : c));
  };

  const openCardRef = useRef(openCard);
  openCardRef.current = openCard;
  const shownCard = shownId && !shownId.startsWith(CHG) && !shownId.startsWith(GIVE) ? cards[shownId] : undefined;
  // A change request stays on screen while it settles, even after it left the list.
  const [heldChange, setHeldChange] = useState<ChangeItem | null>(null);
  const shownChange = shownId && shownId.startsWith(CHG)
    ? changes.find((c) => `${CHG}${c.requestId}` === shownId) ?? (heldChange && `${CHG}${heldChange.requestId}` === shownId ? heldChange : null)
    : null;
  useEffect(() => {
    if (chrome.panel && shownId && !shownId.startsWith(CHG) && !shownId.startsWith(GIVE) && !cards[shownId]) void openCard(shownId);
  }, [chrome.panel, shownId, cards, openCard]);

  const shownGive = shownId && shownId.startsWith(GIVE) ? shownGives.find((g) => g.key === shownId) ?? null : null;
  useEffect(() => {
    const cur = giving.step !== 'idle' ? giving.item : null;
    if (shownGive && (!cur || cur.key !== shownGive.key) && !settling) giver.open(shownGive);
  }, [shownGive, giving, giver, settling]);
  // Given on this phone: the AI's request it carried out is closed as `replaced`, signed by this phone like any decision (the gateway page
  // does the same after a give from its card). A request already closed elsewhere is left as it is.
  const closedFor = useRef(new Set<string>());
  useEffect(() => {
    const pid = (giving.step === 'signed' || giving.step === 'not_received') ? giving.item.proposalId : undefined;
    if (!pid || closedFor.current.has(pid)) return;
    closedFor.current.add(pid);
    void (async () => {
      const r = await rt.reader.get(pid, true);
      if (!r.ok || r.data.status !== 'pending') return;
      const check = await checkCard(rt.checks, r.data);
      if (!check.ok) return;
      await rt.decider.decide(r.data, check.ready, 'reject', { outcome: 'replaced' }).catch(() => {});
      void load(false);
    })();
  }, [giving, rt, load]);

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
    setHeldChange(null);
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

  // A change request settled: a confirmation shows the stamp for the gateway's time, then the next opens; "Not allowed", "Run out" or a
  // failure stays until Next / Close (the gateway's rule for a refused approval).
  const changeSettled = useCallback((id: string, item: ChangeItem, outcome: 'done' | 'stay') => {
    setHeldChange(item);
    handleDecided(id);
    handleOutcome(id, outcome === 'done' ? 'done' : 'refused');
  }, [handleDecided, handleOutcome]);

  // What opens after a decided card: named on its result while it waits (UI review, DEC-88; the gateway's rule).
  const nextProposalOf = (before: string[], id: string) => {
    const n = afterDecision(before, id).next;
    return n ? (proposals ?? []).find((p) => p.id === n) ?? null : null;
  };
  if (chrome.panel) {
    const before = settling ? settling.before : ids;
    const pos = positionOf(before, shownId);
    const nextId = shownId ? afterDecision(before, shownId).next : null;
    const nextChange = nextId && nextId.startsWith(CHG) ? changesRef.current.find((c) => `${CHG}${c.requestId}` === nextId) : undefined;
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
        other={shownId && shownId.startsWith(GIVE) && giving.step !== 'idle' && giving.item?.key === shownId ? {
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
        } : shownId && shownChange ? {
          key: shownId,
          node: (
            <ChangeSlot
              key={shownId} rt={rt} item={shownChange} onBusyChange={setBusy}
              onSettled={(outcome) => changeSettled(shownId, shownChange, outcome)}
              dismissLabel={resultDismissLabel(afterDecision(settling?.before ?? ids, shownId).next !== null)}
              onDismiss={() => finishSettling(shownId)}
              nextTitle={nextChange ? changeTitle(nextChange) : null}
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
  // Notes about mandates are never waiting items: a mandate given on another device is already in "Your mandates"; one ended on another
  // device is said once, under "Your mandates" (maintainer, 2026-11-23: notes under "Waiting for you" read as things to do).
  const endedNotes = endedElsewhere.filter((e) => now - e.at < 14 * 86400).map((e) => P.noticeEnded(e.title, e.by));
  return (
    <RequestsScreen
      waiting={shownGives.length > 0 ? (
        <div className="dash-rows" data-testid="give-list">
          {shownGives.map((g) => <GiveRow key={g.key} item={g} nowSeconds={now} onOpen={() => { setCurrentId(g.key); setPanel((p) => ({ ...p, open: true, owed: false })); }} />)}
        </div>
      ) : undefined}
      waitingCount={shownGives.length}
      below={<OwnMandates items={own} notes={endedNotes} onEnd={(m) => ender.open(m)} />}
      proposals={listedProposals} error={error} nowMs={Date.now()}
      changes={changes}
      onOpenChange={(rid) => { setCurrentId(`${CHG}${rid}`); setPanel((p) => ({ ...p, open: true, owed: false })); }}
      onOpen={(id) => { setCurrentId(id); setPanel((p) => ({ ...p, open: true, owed: false })); }}
      onRefresh={() => void load(true)}
      missed={missed}
      pushOffer={offer ? { ...offer, onOn: () => void turnOn(), onNotNow: () => { setOffer(null); void rt.push.dismissOffer(); } } : undefined}
    />
  );
}

/** The panel's id of a change request: kept apart from proposal ids. */
const CHG = 'chg:';
/** The panel's id of a mandate to give (GiveItem.key starts with it). */
const GIVE = 'give:';

/** One change request's card with its driver (stage D3). Locks the panel's head while the touch, the sending and the stamp are on. */
function ChangeSlot({ rt, item, onBusyChange, onSettled, dismissLabel, onDismiss, nextTitle }: {
  rt: Rt; item: ChangeItem; onBusyChange: (busy: boolean) => void; onSettled: (outcome: 'done' | 'stay') => void;
  dismissLabel: string; onDismiss: () => void; nextTitle: string | null;
}) {
  // One driver per request: a list refresh hands over a new object for the same request, which must not reset a touch in progress.
  const driver = useMemo(() => new ChangeConfirmDriver({ keys: rt.keys, api: rt.api, accounts: rt.accounts, session: rt.session, now: rt.now, check: rt.check }, item), [rt, item.requestId]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = useDriver(driver);
  const now = useNowSeconds(rt.now);
  const locked = state.step === 'touch' || state.step === 'sending' || state.step === 'confirmed';
  useEffect(() => { onBusyChange(locked); }, [locked, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  const settledRef = useRef(false);
  useEffect(() => {
    if (settledRef.current) return;
    if (state.step === 'confirmed') { settledRef.current = true; onSettled('done'); }
    else if (state.step === 'denied' || state.step === 'expired' || state.step === 'failed') { settledRef.current = true; onSettled('stay'); }
  }, [state.step, onSettled]);
  return (
    <ChangeCard
      item={item} state={state} nowSeconds={now}
      onConfirm={() => void driver.confirm()} onDeny={() => void driver.deny()} onCancelTouch={() => driver.cancelTouch()}
      dismissLabel={dismissLabel} onDismiss={onDismiss} nextTitle={nextTitle}
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
  const [push, setPush] = useState<{ state: PushState; busy: boolean; error?: string } | null>(null);

  useEffect(() => { void rt.push.state().then((state) => setPush({ state, busy: false })); }, [rt]);
  // A passkey for the suveren.ai dashboard that waits for one of this person's devices (AS step 17): a row, then the shared card.
  const [passkeys, setPasskeys] = useState<PendingPasskey[]>([]);
  const [passkeyOpen, setPasskeyOpen] = useState(false);
  const [passkeyView, setPasskeyView] = useState<PasskeyCardView>({ s: 'offered' });
  const passkeyGen = useRef(0);
  const readPasskeys = useCallback(async () => { setPasskeys(await readPendingPasskeys({ api: rt.api, session: rt.session, now: rt.now })); }, [rt]);
  useEffect(() => { void readPasskeys(); }, [readPasskeys]);
  const approveOne = useCallback(async (item: PendingPasskey) => {
    const g = ++passkeyGen.current;
    setPasskeyView({ s: 'touch' });
    const code = await approvePasskey({ keys: rt.keys, check: rt.check, api: rt.api, accounts: rt.accounts, session: rt.session, now: rt.now }, item);
    if (g !== passkeyGen.current) return;
    setPasskeyView(code === null ? { s: 'added' } : { s: 'offered', error: passkeyRefusalText(code) });
  }, [rt]);

  const changePush = useCallback(async (on: boolean) => {
    const bearer = rt.session.bearer();
    if (!bearer) { onEnded(); return; }
    rt.session.noteUse();
    setPush((cur) => (cur ? { ...cur, busy: true, error: undefined } : cur));
    const r = on ? await rt.push.turnOn(bearer) : await rt.push.turnOff(bearer);
    setPush({ state: await rt.push.state(), busy: false, error: r.ok ? undefined : errorText(r.code) });
  }, [rt, onEnded]);
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
  if (passkeyOpen && passkeys[0]) {
    const item = passkeys[0];
    return (
      <DashboardPasskeyCard
        request={{ code: item.code, email: item.email, credentialAt: item.credentialAt, expiresAt: item.expiresAt }}
        view={passkeyView} canApprove
        onApprove={() => void approveOne(item)}
        onCancel={() => { passkeyGen.current++; setPasskeyView({ s: 'offered' }); }}
        onClose={() => { setPasskeyOpen(false); setPasskeyView({ s: 'offered' }); void readPasskeys(); }} />
    );
  }
  // DEC-98: the screen appears in one go once the device list, the identity code and the notification state are in.
  const devicesReady = (code !== null || error !== undefined) && push !== null;
  return (
    <LoadGate parts={['devices']}>
    <PhoneDevicesGated ready={devicesReady}>
    {passkeys.length > 0 && (
      <div className="alert alert-info" role="status" data-testid="passkey-waiting-row" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', justifyContent: 'space-between', margin: '0.75rem' }}>
        <span>{PASSKEY_TEXT.waitingRow}</span>
        <button type="button" className="btn btn-primary" style={{ minHeight: 44 }} onClick={() => setPasskeyOpen(true)} data-testid="passkey-open">{PASSKEY_TEXT.open}</button>
      </div>
    )}
    <DevicesScreen
      rows={rows} identityCode={code} nowSeconds={rt.now()} persistent={persistent} updated={updated}
      version={VERSION} build={BUILD_COMMIT} onAddComputer={onAdd} onRefresh={() => void refresh()} busy={busy} error={error}
      onRemove={(keyId) => void remover.start(keyId)} notices={notices}
      rotateOffer={offer} onRotate={() => rotator.start()}
      push={push ? { ...push, onOn: () => void changePush(true), onOff: () => void changePush(false) } : undefined}
    />
    </PhoneDevicesGated>
    </LoadGate>
  );
}

function PhoneDevicesGated({ ready, children }: { ready: boolean; children: ReactNode }) {
  const settled = useNetworkSettled();
  return <Gated part="devices" ready={ready && settled} skeleton={<PhoneDevicesSkeleton />}>{children}</Gated>;
}

/** DEC-98: the phone's devices screen greyed out — title, two device rows, the identity code and the main button. */
function PhoneDevicesSkeleton() {
  return (
    <div className="device-screen" data-testid="devices-skeleton">
      <SkelArea>
        <SkelTitle w="50%" />
        {[0, 1].map(i => (
          <div key={i} style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.9rem' }}>
            <SkelBlock w="2.25rem" h="2.25rem" radius="50%" />
            <div style={{ flex: 1 }}><SkelLine w="45%" style={{ marginBottom: '0.4rem' }} /><SkelLine w="70%" h="0.7rem" /></div>
          </div>
        ))}
        <SkelLine w="35%" style={{ margin: '1rem 0 0.5rem' }} />
        <SkelBlock h="1.6rem" style={{ marginBottom: '1.25rem' }} />
        <SkelButton full large />
        <div style={{ height: '0.75rem' }} />
        <SkelButton full />
      </SkelArea>
    </div>
  );
}

/** A notice from the chain, in words (mockup F1, F3). */
function noticeText(n: ChainNotice, now: number): string {
  const by = n.by ?? P.noticeByCode;
  if (n.kind === 'added') return P.noticeAdded(n.label, whenText(n.at, now), by);
  if (n.kind === 'removed') return P.noticeRemoved(n.label, by);
  if (n.kind === 'touch-id') return P.noticeTouchId(n.label, whenText(n.at, now));
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
