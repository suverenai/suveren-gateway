import { useCallback, useEffect, useRef, useState } from 'react';
import { JoinCompare, joinErrorText, S13, type AdminJoinApi, type JoinCheck, type JoinRequestView, type JoinResult, type JoinState, type MemberJoinApi } from '@suveren/approval-card/mandate-screens';
import { spClient } from '../../lib/sp-client';

/** What the screen does with a check answer: the same for both sides. */
function afterCheck(r: JoinResult<JoinCheck>): JoinState {
  if (!r.ok) {
    if (r.code === 'tries_used') return { phase: 'locked' };
    return { phase: 'error', text: joinErrorText(r.code) };
  }
  if (r.match) return { phase: 'matched' };
  return r.triesLeft === 0 ? { phase: 'locked' } : { phase: 'wrong', triesLeft: r.triesLeft };
}

const POLL_MS = 5000;

/**
 * The member's column on the gateway page (and, with the same props, the phone app): the person asked to join `teamId`
 * and compares identity codes with the admin. Everything shown is what the gateway answered, never remembered here: a
 * reload asks `view` again, so a match and a signed anchor survive it.
 */
export function JoinMemberHost({ teamId, teamName, adminName, memberName, api = spClient.memberJoin, onLocked }: {
  teamId: string; teamName: string; adminName: string | null; memberName?: string; api?: MemberJoinApi;
  /** Three wrong codes: the request is withdrawn on this side (the host of the page does it). */
  onLocked: () => void;
}) {
  const [yourCode, setYourCode] = useState<string | null>(null);
  const [state, setState] = useState<JoinState>({ phase: 'compare' });
  const [typed, setTyped] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const locked = useRef(false);

  const lock = useCallback(() => { if (!locked.current) { locked.current = true; onLocked(); } }, [onLocked]);

  useEffect(() => {
    let live = true;
    void api.view(teamId).then(r => {
      if (!live) return;
      if (!r.ok) { setLoadError(joinErrorText(r.code)); return; }
      setYourCode(r.yourCode);
      if (r.anchored) setState({ phase: 'waiting' });
      else if (r.triesLeft === 0) { setState({ phase: 'locked' }); lock(); }
      else if (r.compared) setState({ phase: 'matched' });
    });
    return () => { live = false; };
  }, [api, teamId, lock]);

  // While waiting, the page's own polling of the team decides when the person is in; nothing is assumed here.
  if (loadError) return <p role="alert" className="msg-error" data-testid="join-load-error">{loadError}</p>;
  if (yourCode === null) return <p role="status">{S13.joinChecking}</p>;

  const check = async () => {
    setState({ phase: 'checking' });
    const next = afterCheck(await api.check(teamId, typed));
    setState(next);
    if (next.phase === 'locked') lock();
    if (next.phase === 'matched' || next.phase === 'locked') setTyped('');
  };
  const sign = async () => {
    setState({ phase: 'touch' });
    const r = await api.anchor(teamId);
    setState(r.ok ? { phase: 'waiting' } : { phase: 'error', text: joinErrorText(r.code), matched: r.code !== 'not_compared' });
  };
  const admin = adminName ?? S13.heldAdminUnknown;
  return (
    <JoinCompare role="member" facts={{ memberName: memberName ?? '', adminName: admin, teamName, yourCode }} state={state}
      typed={typed} onType={setTyped} onCheck={() => void check()} onSign={() => void sign()} />
  );
}

/** One request on the admin's list: opens the compare screen for that person. */
function AdminRequestRow({ teamId, teamName, yourCode, request, api, onChanged, onAdded }: {
  teamId: string; teamName: string; yourCode: string; request: JoinRequestView; api: AdminJoinApi; onChanged: () => void; onAdded: (name: string) => void;
}) {
  const [open, setOpen] = useState(request.compared);
  const [typed, setTyped] = useState('');
  const [state, setState] = useState<JoinState>(request.triesLeft === 0 && request.hasDid ? { phase: 'locked' } : request.compared ? { phase: 'matched' } : { phase: 'compare' });
  const name = request.memberName;

  if (!request.hasDid) {
    return <div className="card" data-testid="join-request"><div>{name}</div><p className="msg-error" role="alert">{joinErrorText('member_has_no_chain', name)}</p></div>;
  }
  if (!open) {
    return (
      <div className="card" data-testid="join-request" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>{name}</div>
        <button type="button" className="btn btn-primary" data-testid="join-open" onClick={() => setOpen(true)}>{S13.joinOpen}</button>
      </div>
    );
  }
  const check = async () => {
    setState({ phase: 'checking' });
    const next = afterCheck(await api.check(teamId, request.userId, typed));
    setState(next);
    if (next.phase === 'matched') { setTyped(''); onChanged(); }
  };
  const add = async () => {
    setState({ phase: 'touch' });
    const r = await api.add(teamId, request.userId);
    if (r.ok) { setState({ phase: 'done' }); onAdded(name); onChanged(); return; }
    setState({ phase: 'error', text: joinErrorText(r.code, name), matched: r.code !== 'not_compared' });
    onChanged();
  };
  return (
    <JoinCompare role="admin" facts={{ memberName: name, adminName: '', teamName, yourCode, anchor: request.anchor }} state={state}
      typed={typed} onType={setTyped} onCheck={() => void check()} onSign={() => void add()} />
  );
}

/**
 * The admin's column: every request to join the admin's team, with the admin's own code. While a request is compared the
 * list asks again every few seconds, so the Add button opens when the member's anchor arrives (it stays off until the
 * gateway has verified it against the member's own devices).
 */
export function JoinRequestsHost({ teamId, teamName, api = spClient.adminJoin, onAdded }: { teamId: string; teamName: string; api?: AdminJoinApi; onAdded?: () => void }) {
  const [view, setView] = useState<{ yourCode: string; requests: JoinRequestView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A person who was added leaves the list of requests (the gateway answers what is pending); the result stays on screen.
  const [added, setAdded] = useState<string[]>([]);
  const load = useCallback(async () => {
    const r = await api.view(teamId);
    if (!r.ok) { setError(joinErrorText(r.code)); return; }
    setError(null);
    setView({ yourCode: r.yourCode, requests: r.requests });
  }, [api, teamId]);
  useEffect(() => { void load(); }, [load]);
  const waiting = view?.requests.some(q => q.hasDid && q.compared && q.anchor !== 'ok') ?? false;
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [waiting, load]);
  if (error) return <p role="alert" className="msg-error">{error}</p>;
  if (!view) return null;
  return (
    <section data-testid="join-requests" style={{ maxWidth: 520 }}>
      <h3 className="card-title">{S13.joinRequestsTitle}</h3>
      {added.map(n => <p key={n} role="status" data-testid="join-result" className="msg-success">{S13.joinAdminDone(n)}</p>)}
      {view.requests.length === 0 && added.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>{S13.joinRequestsNone}</p>}
      {view.requests.map(q => (
        <AdminRequestRow key={q.userId} teamId={teamId} teamName={teamName} yourCode={view.yourCode} request={q} api={api}
          onChanged={() => { void load(); }} onAdded={n => { setAdded(a => [...a, n]); onAdded?.(); }} />
      ))}
    </section>
  );
}
