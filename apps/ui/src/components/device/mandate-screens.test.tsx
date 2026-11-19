import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MandateDiff } from '@hap/core/mandate-change';
import {
  S13, HeldBackList, EndMandate, ChangeMandate, JoinCompare, ColleagueList, teamDiff, heldReason, groupCode, isExtendOnly,
  type HeldBackMandate, type TeamTerms,
} from '@suveren/approval-card/mandate-screens';
import { endIsDeviceSigned } from '../../lib/end-mandate';
import { spClient } from '../../lib/sp-client';

const text = (el: React.ReactElement): string => renderToStaticMarkup(el).replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const noop = () => {};

const held = (over: Partial<HeldBackMandate>): HeldBackMandate => ({ mandateId: 'm1', profileName: 'Sales', ownerName: 'Anna Muster', ownerIsYou: false, reason: 'not_received', adminName: 'Dana Berg', ...over });

describe('screen 3: held back', () => {
  const t = (m: Partial<HeldBackMandate>) => text(<HeldBackList mandates={[held(m)]} />);
  it('shows nothing when nothing is held', () => expect(renderToStaticMarkup(<HeldBackList mandates={[]} />)).toBe(''));
  it('not received: reason and Check again', () => {
    const s = t({});
    for (const x of [S13.heldTitle, 'Sales, from Anna Muster', S13.heldNotReceived, S13.heldCheckAgain]) expect(s).toContain(x);
  });
  it('no check from another person: one next step, no button', () => {
    const html = renderToStaticMarkup(<HeldBackList mandates={[held({ reason: 'check_required' })]} />);
    expect(text(<HeldBackList mandates={[held({ reason: 'check_required' })]} />)).toContain(S13.heldNoCheckStep);
    expect(html).not.toContain('<button');
  });
  it('owner not on the admin list names the admin', () => expect(t({ reason: 'owner_unknown' })).toContain('Ask Dana Berg, your admin, to confirm her.'));
  it('changed and ended', () => {
    expect(t({ reason: 'changed' })).toContain(S13.heldChangedStep);
    const e = t({ reason: 'revoked' });
    expect(e).toContain('Anna Muster ended this mandate. This is final.'); expect(e).toContain(S13.heldEndedStep);
  });
  it('own mandate without Touch ID: Give it again', () => {
    const s = t({ reason: 'check_required', ownerIsYou: true, ownerName: null });
    expect(s).toContain('Sales, from you'); expect(s).toContain(S13.heldOwnNoCheck); expect(s).toContain(S13.heldGiveAgain);
  });
  it('gateway codes map to reasons', () => {
    expect(heldReason('no_grant')).toBe('not_received'); expect(heldReason('CHECK_REQUIRED')).toBe('check_required');
    expect(heldReason('owner_unknown')).toBe('owner_unknown'); expect(heldReason('mandate_revoked')).toBe('revoked'); expect(heldReason('grant_member_differs')).toBe('changed');
  });
});

describe('screen 4: End a mandate', () => {
  const facts = { profileName: 'Sales', limits: [{ label: 'Value of one offer', value: 'up to 500 EUR' }], activeUntil: '3 Dec 2026, 14:20' };
  const r = (state: Parameters<typeof EndMandate>[0]['state']) => text(<EndMandate facts={facts} state={state} onEnd={noop} onKeep={noop} />);
  it('confirm', () => {
    const s = r({ phase: 'confirm' });
    for (const x of [S13.endTitle, 'The mandate for Sales', S13.endAtOnce, S13.endFinal, 'up to 500 EUR', '3 Dec 2026, 14:20', S13.endNoTouch, S13.endButton, S13.endKeep]) expect(s).toContain(x);
    expect(s).not.toContain('Touch ID to give');
  });
  it('busy disables both buttons', () => expect(renderToStaticMarkup(<EndMandate facts={facts} state={{ phase: 'busy' }} onEnd={noop} onKeep={noop} />).match(/disabled/g)?.length).toBe(2));
  it('result and errors', () => {
    expect(r({ phase: 'done' })).toBe(S13.endDone('Sales'));
    expect(r({ phase: 'error', code: 'already_ended' })).toContain(S13.endAlready);
    expect(r({ phase: 'error', code: 'unknown' })).toContain(S13.endUnknown);
    expect(r({ phase: 'error', code: 'offline' })).toContain(S13.endOffline);
  });
});

describe('the End route', () => {
  const answer = (status: number, body: unknown) => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    return spy;
  };
  it('posts the device-signed revoke and maps the gateway answers', async () => {
    const spy = answer(200, { ok: true });
    expect(await spClient.endMandate('authz_00000000-0000-0000-0000-000000000000')).toEqual({ ok: true });
    expect(String(spy.mock.calls[0][0])).toContain('/api/mandate/revoke');
    answer(422, { code: 'grant_refused', grantCode: 'mandate_revoked' });
    expect(await spClient.endMandate('authz_x')).toEqual({ ok: false, code: 'already_ended' });
    answer(502, {});
    expect(await spClient.endMandate('authz_x')).toEqual({ ok: false, code: 'offline' });
    vi.restoreAllMocks();
  });
  it('only a gateway with a device chain ends by device key', () => {
    expect(endIsDeviceSigned({ deviceKeysSwitch: true, access: 'password' }, { setUp: true })).toBe(true);
    expect(endIsDeviceSigned({ deviceKeysSwitch: true, access: 'password' }, { setUp: false })).toBe(false);
    expect(endIsDeviceSigned({ deviceKeysSwitch: false, access: 'legacy' }, { setUp: true })).toBe(false);
    expect(endIsDeviceSigned({ deviceKeysSwitch: true, access: 'password' }, null)).toBe(false);
  });
});

const baseDiff: MandateDiff = { rows: [], stays: [{ label: 'Offers per day', value: '10' }] };
const limitRow = { section: 'limit' as const, field: 'amount', label: 'Value of one offer', unit: 'currency:EUR', before: 500, after: 800, tag: 'More' as const };
const scopeRow = { section: 'scope' as const, field: 'region', label: 'Region', before: null, after: null, added: ['Switzerland'], tag: 'New' as const };
const change = (diff: MandateDiff, team = teamDiff(null, null), extra: object = {}) =>
  text(<ChangeMandate profileName="Sales" diff={diff} team={team} state={{ phase: 'review' }} onChange={noop} onCancel={noop} {...extra} />);

describe('screen 5: change a mandate', () => {
  it('lists only the differences, with the owner-only line and the touch', () => {
    const s = change({ ...baseDiff, rows: [limitRow, scopeRow], lastsUntil: { before: 1796000000, after: 1796600000, tag: 'More' }, intent: [{ kind: 'same', text: 'Follow up in ' }, { kind: 'del', text: 'Austria' }, { kind: 'add', text: 'Austria and Switzerland' }] }, teamDiff(null, null), { intentByAi: true });
    for (const x of [S13.changeTitle('Sales'), S13.changeOnlyListed, S13.changeOnlyOwner, S13.changeLimits, 'Value of one offer', S13.tagMore, S13.changeScope, 'Switzerland', S13.tagNew, S13.changeHowLong, S13.changeWhy, S13.changeFromAi, S13.changeStays, 'Offers per day: 10', S13.changeWhenTouch, S13.changeButton, S13.changeCancel]) expect(s).toContain(x);
  });
  it('covers approvers, approval count and team limits', () => {
    const before: TeamTerms = { approvers: ['Ben Huber', 'Carla Weiss'], approvals: 1, limits: [{ field: 'amount', label: 'Value of one offer', value: 2000, unit: 'EUR' }] };
    const after: TeamTerms = { approvers: ['Ben Huber', 'Dana Berg'], approvals: 2, limits: [{ field: 'amount', label: 'Value of one offer', value: 3000, unit: 'EUR' }] };
    const rows = teamDiff(before, after);
    expect(rows.map(r => r.key)).toEqual(['approvers', 'approvals', 'limit:amount']);
    expect(rows[2].tag).toBe('More');
    const s = change({ ...baseDiff, rows: [limitRow] }, rows);
    for (const x of [S13.changeApprovals, S13.changeApprovers, 'Dana Berg', 'Carla Weiss', S13.changeApprovalCount, 'Team limit: Value of one offer', '2000 EUR', '3000 EUR']) expect(s).toContain(x);
    expect(teamDiff(before, before)).toEqual([]);
  });
  it('a mode change shows as an approvals line', () => expect(change({ ...baseDiff, mode: { before: 'review', after: 'automatic', tag: 'More' }, rows: [limitRow] })).toContain(S13.changeMode));
  it('extend only', () => {
    const d: MandateDiff = { rows: [], stays: [], lastsUntil: { before: 1796000000, after: 1797000000, tag: 'More' } };
    expect(isExtendOnly(d, [])).toBe(true);
    const s = change(d);
    expect(s).toContain(S13.extendTitle('Sales')); expect(s).toContain(S13.extendNothingElse); expect(s).toContain(S13.extendButton); expect(s).not.toContain(S13.changeOnlyListed);
  });
  it('version move', () => expect(change({ ...baseDiff, rows: [limitRow], versionMove: { from: '0.2', to: '0.3' } })).toContain('from version 0.2 to 0.3'));
  it('result and errors', () => {
    const r = (state: Parameters<typeof ChangeMandate>[0]['state']) => text(<ChangeMandate profileName="Sales" diff={baseDiff} team={[]} state={state} onChange={noop} onCancel={noop} />);
    expect(r({ phase: 'done' })).toBe(S13.changeDone('Sales'));
    expect(r({ phase: 'error', code: 'changed_since_proposal' })).toContain(S13.changeChangedSince);
    expect(r({ phase: 'error', code: 'no_change' })).toContain(S13.changeNoChange);
    expect(r({ phase: 'error', code: 'not_your_mandate' })).toContain(S13.changeNotYours);
    expect(r({ phase: 'error', code: 'mandate_not_active' })).toContain(S13.changeNotActive);
    expect(r({ phase: 'error', code: 'cancelled' })).toContain(S13.changeCancelled);
  });
});

describe('screen 2: codes at the join (interface only)', () => {
  const facts = { memberName: 'Dana Berg', adminName: 'Anna Muster', teamName: 'Muster GmbH', yourCode: '73142208556109423375', theirCode: '48217035116922840937' };
  it('groups a code in fours', () => expect(groupCode('73142208556109423375')).toBe('7314 2208 5561 0942 3375'));
  it('admin screen', () => {
    const s = text(<JoinCompare role="admin" facts={facts} state={{ phase: 'compare' }} onMatch={noop} onDiffer={noop} />);
    for (const x of [S13.joinAdminTitle('Dana Berg', 'Muster GmbH'), S13.joinAdminIntro('Dana Berg'), S13.joinYourCode, '7314 2208 5561 0942 3375', "Dana Berg's code", '4821 7035 1169 2284 0937', S13.joinCompareHint, S13.joinMatch('Dana Berg'), S13.joinDiffer]) expect(s).toContain(x);
  });
  it('member screen has the labels swapped', () => {
    const html = renderToStaticMarkup(<JoinCompare role="member" facts={facts} state={{ phase: 'compare' }} onMatch={noop} onDiffer={noop} />);
    expect(html.indexOf('join-code-other')).toBeLessThan(html.indexOf('join-code-own'));
    expect(text(<JoinCompare role="member" facts={facts} state={{ phase: 'compare' }} onMatch={noop} onDiffer={noop} />)).toContain(S13.joinMemberIntro('Muster GmbH', 'Anna Muster'));
  });
  it('results', () => {
    const r = (role: 'admin' | 'member', phase: 'done' | 'differ' | 'waiting') => text(<JoinCompare role={role} facts={facts} state={{ phase }} onMatch={noop} onDiffer={noop} />);
    expect(r('admin', 'done')).toBe(S13.joinAdminDone('Dana Berg'));
    expect(r('admin', 'differ')).toBe(S13.joinDifferResult('Dana Berg'));
    expect(r('member', 'waiting')).toBe(S13.joinWaiting('Anna Muster'));
    expect(r('member', 'done')).toBe(S13.joinMemberDone('Muster GmbH', 'Anna Muster'));
    expect(r('member', 'differ')).toBe(S13.joinMemberDifferResult);
  });
  it('colleagues list', () => {
    const s = text(<ColleagueList adminName="Anna Muster" colleagues={[{ name: 'Ben Huber', confirmedBy: 'Anna Muster' }, { name: 'Anna Muster', confirmedBy: 'you' }]} />);
    for (const x of [S13.colleaguesTitle, 'confirmed by Anna Muster', S13.confirmedByYou, S13.colleaguesWhy('Anna Muster')]) expect(s).toContain(x);
  });
});
