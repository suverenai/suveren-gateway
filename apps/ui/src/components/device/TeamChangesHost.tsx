import { useCallback, useEffect, useRef, useState } from 'react';
import { S13, TeamChangesPanel, joinErrorText, type JoinCheck, type JoinResult, type TeamChangesApi, type TeamChangesView } from '@suveren/approval-card/mandate-screens';
import { spClient } from '../../lib/sp-client';
import { JoinMemberHost } from './JoinHosts';

const POLL_MS = 10_000;

/**
 * Changes to the team's member list after the join (DEC-73 step 5), on the Team page. Everything shown is what the gateway answered
 * (a reload asks again); the host owns only what is typed and whether a touch is open. The gateway builds and signs every list from the
 * list it verified itself: nothing here decides what is signed. Wording: the maintainer's (all texts are DRAFT in the texts module).
 */
export function TeamChangesHost({ teamId, teamName, api = spClient.teamChanges, onChanged }: { teamId: string; teamName: string; api?: TeamChangesApi; onChanged?: () => void }) {
  const [changes, setChanges] = useState<TeamChangesView | null>(null);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [wrong, setWrong] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState('');
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const load = useCallback(async () => {
    const r = await api.view(teamId);
    if (!live.current) return;
    if (r.ok) setChanges(r.changes);
    else setChanges(null);
  }, [api, teamId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const id = setInterval(() => { if (!busy) void load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [busy, load]);

  /** One touch (or one step): shows the plain success text or the refusal's sentence, then asks the gateway again. */
  const run = async (step: () => Promise<JoinResult<object>>, done: string, name?: string) => {
    setBusy(true); setResult(null);
    const r = await step();
    setBusy(false);
    setResult(r.ok ? { text: done, ok: true } : { text: joinErrorText(r.code, name), ok: false });
    await load();
    if (r.ok) onChanged?.();
  };

  if (!changes) return null;
  const nameOf = (did: string): string => (changes.role === 'admin' ? changes.remove.find(o => o.did === did)?.name ?? changes.replace.find(o => o.oldDid === did)?.name : undefined) ?? '';

  // A member whose admin changed compares codes with the new admin again (the join screen, same gateway rules).
  if (changes.role === 'member' && changes.adminChanged) {
    return (
      <section data-testid="team-changes" style={{ maxWidth: 520 }}>
        <p>{S13.changesAdminChanged}</p>
        <JoinMemberHost teamId={teamId} teamName={teamName} adminName={null} onLocked={() => { void load(); }} />
      </section>
    );
  }
  return (
    <TeamChangesPanel
      changes={changes} busy={busy} typed={typed} chosen={chosen} result={result} wrong={wrong}
      actions={{
        remove: did => { const n = nameOf(did); void run(() => api.remove(teamId, did), S13.changesRemoveDone(n), n); },
        replaceType: (userId, v) => setTyped(t => ({ ...t, [userId]: v })),
        replaceCheck: userId => {
          void (async () => {
            setBusy(true); setResult(null);
            const r: JoinResult<JoinCheck> = await api.replaceCheck(teamId, userId, typed[userId] ?? '');
            setBusy(false);
            const name = changes.role === 'admin' ? changes.replace.find(o => o.userId === userId)?.name ?? '' : '';
            if (!r.ok) { setResult({ text: joinErrorText(r.code, name), ok: false }); return; }
            if (r.match) { setTyped(t => ({ ...t, [userId]: '' })); setWrong(w => ({ ...w, [userId]: '' })); }
            else setWrong(w => ({ ...w, [userId]: `${S13.joinWrongAdmin(name)} ${S13.joinTriesLeft(r.triesLeft)}` }));
            await load();
          })();
        },
        replace: userId => { const n = changes.role === 'admin' ? changes.replace.find(o => o.userId === userId)?.name ?? '' : ''; void run(() => api.replace(teamId, userId), S13.changesNewIdentityDone(n), n); },
        resign: () => { void run(() => api.resign(teamId), S13.changesResignDone); },
        handoverChoose: setChosen,
        handoverOffer: () => { void run(() => api.handoverOffer(teamId, chosen), S13.changesHandoverWaitingNew); },
        handoverBuild: () => { void run(() => api.handoverBuild(teamId), S13.changesHandoverWaitingOld); },
        handoverSign: () => { void run(() => api.handoverSign(teamId), S13.changesHandoverDone); },
        handoverWithdraw: () => { void run(() => api.handoverWithdraw(teamId), S13.changesNone); },
      }}
    />
  );
}
