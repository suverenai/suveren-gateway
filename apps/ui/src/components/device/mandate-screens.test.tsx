import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MandateDiff } from '@hap/core/mandate-change';
import {
  S13, GiveApprovers, giveBlocked, approverLines, limitRows, limitValueText, durationText, endDateText, giveErrorText, HeldBackList, EndMandate, ChangeMandate, JoinCompare, ColleagueList, joinErrorText, teamDiff, heldReason, groupCode, isExtendOnly,
  type HeldBackMandate, type TeamTerms, type JoinState,
} from '@suveren/approval-card/mandate-screens';
import { endIsDeviceSigned } from '../../lib/end-mandate';
import { spClient } from '../../lib/sp-client';

const text = (el: React.ReactElement): string => renderToStaticMarkup(el).replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const noop = () => {};

const held = (over: Partial<HeldBackMandate>): HeldBackMandate => ({ mandateId: 'm1', profileName: 'Sales', title: null, ownerName: 'Anna Muster', ownerIsYou: false, reason: 'alarm', adminName: 'Dana Berg', workspace: 'team', ...over });
const own = (over: Partial<HeldBackMandate>): HeldBackMandate => held({ ownerIsYou: true, ownerName: null, title: 'Records · Meeting notes', profileName: 'Records', ...over });

// Approved On-hold mockup v2 (temp/onhold-mockup/onhold.html, maintainer 2026-11-24, DEC-109/110/111).
describe('screen 3: on hold (mockup v2)', () => {
  const t = (...ms: HeldBackMandate[]) => text(<HeldBackList mandates={ms} onGiveAgain={noop} onEnd={noop} />);
  const html = (...ms: HeldBackMandate[]) => renderToStaticMarkup(<HeldBackList mandates={ms} onGiveAgain={noop} onEnd={noop} />);
  it('shows nothing when nothing is held', () => expect(renderToStaticMarkup(<HeldBackList mandates={[]} />)).toBe(''));

  it('every gateway code goes to its place (the mockup table)', () => {
    for (const c of ['mandate_body_not_received', 'body_not_received', 'no_grant']) expect(heldReason(c)).toBe('not_received');
    for (const c of ['grant_check_required', 'mandate_not_granted', 'CHECK_REQUIRED', 'check_required']) expect(heldReason(c)).toBe('touch_missing');
    for (const c of ['owner_unknown', 'owner_not_this_person']) expect(heldReason(c)).toBe('waiting_confirm');
    expect(heldReason('profile_hash_mismatch')).toBe('rules_changed');
    for (const c of ['mandate_body_mismatch', 'grant_mismatch', 'grant_invalid', 'grant_other_authorization', 'grant_other_team', 'mandate_body_refused', 'grant_version_refused']) expect(heldReason(c)).toBe('alarm');
    expect(heldReason('mandate_revoked')).toBe('ended');
    // maintainer 2026-11-24: an unknown code is neutral, never the alarm.
    for (const c of ['mandate_unavailable', 'body_unavailable', 'owner_has_no_chain', 'something_new']) expect(heldReason(c)).toBe('unknown');
  });

  it('case 2: a give on its way is never shown on the gateway; an ended mandate is not on hold', () => {
    expect(html(own({ reason: 'not_received' }))).toBe('');
    expect(html(held({ reason: 'ended' }))).toBe('');
  });

  it('case 3: the alarm, own mandate, Personal workspace: no admin line, Give again and End', () => {
    const m = own({ reason: 'alarm', workspace: 'personal' });
    const s = t(m);
    expect(s).toContain(S13.heldTitle);
    expect(s).toContain('Records · Meeting notes');
    expect(s).toContain('✕ This mandate does not match what you confirmed.');
    expect(s).toContain('Your AI cannot use it. If you did not change it yourself, end it.');
    expect(s).not.toContain('tell your admin');
    expect(s).toContain('Give again'); expect(s).toContain('End');
    expect(html(m)).toContain('font-weight:700');
  });

  it('case 3: the alarm in a team says "tell your admin"; a colleague\'s: no button, only they can give it again', () => {
    expect(t(own({ reason: 'alarm', workspace: 'team' }))).toContain('end it and tell your admin.');
    const c = held({ reason: 'alarm' });
    const s = t(c);
    expect(s).toContain('Sales, from Anna Muster');
    expect(s).toContain('✕ This mandate does not match what Anna Muster confirmed.');
    expect(s).toContain('Only Anna Muster can give it again. Tell them, and tell your admin.');
    expect(html(c)).not.toContain('<button');
  });

  it('case 4: rules changed and touch missing: one button for one\'s own, none for a colleague\'s', () => {
    const r = t(own({ title: 'Email · Replies to customers', profileName: 'Email', reason: 'rules_changed' }));
    expect(r).toContain('The rules for Email changed after you gave this. Give it again under the new rules so your AI can use it.');
    expect(r).toContain('Give again'); expect(r).not.toMatch(/\bEnd\b/);
    expect(t(own({ reason: 'touch_missing' }))).toContain('This was given without your touch. Give it again so your AI can use it.');
    const c = held({ reason: 'touch_missing' });
    expect(t(c)).toContain('Anna Muster gave this without their touch.'); expect(t(c)).toContain('Only Anna Muster can give it again.');
    expect(html(c)).not.toContain('<button');
    expect(html(held({ reason: 'rules_changed' }))).not.toContain('<button');
  });

  it('case 5: unknown reason: the neutral sentence, Give again and End; never "does not match"', () => {
    const s = t(own({ reason: 'unknown' }));
    expect(s).toContain('This mandate is on hold. Your AI cannot use it until it is given again.');
    expect(s).toContain('Give again'); expect(s).toContain('End');
    expect(s).not.toContain('does not match');
  });

  it('case 1: waiting for the admin to confirm a colleague is its own calm section, no button', () => {
    const w = held({ reason: 'waiting_confirm' });
    const s = t(w);
    expect(s).toContain(S13.heldWaitTitle); expect(s).toContain('Waiting');
    expect(s).toContain('Waiting for Dana Berg to confirm Anna Muster. Your AI cannot use this mandate until then.');
    expect(s).not.toContain(S13.heldTitle);
    expect(html(w)).not.toContain('<button');
  });

  it('the phone says "Give again with your touch" and its own title', () => {
    const s = text(<HeldBackList mandates={[own({ reason: 'unknown' })]} host="phone" onGiveAgain={noop} />);
    expect(s).toContain('Give again with your touch'); expect(s).toContain(S13.heldTitlePhone);
  });

  it('a host that cannot act shows the words without a dead button', () => {
    const h = renderToStaticMarkup(<HeldBackList mandates={[own({ reason: 'alarm', workspace: 'personal' })]} host="phone" />);
    expect(h).not.toContain('<button'); expect(text(<HeldBackList mandates={[own({ reason: 'alarm', workspace: 'personal' })]} host="phone" />)).toContain('end it.');
  });

  it('a colleague with no known name is never shown as "you"', () => {
    expect(t(held({ reason: 'alarm', ownerName: null }))).toContain('Sales, from someone in your team');
  });
});

describe('screen 4: End a mandate', () => {
  const facts = { profileName: 'Sales', limits: [{ label: 'Value of one offer', value: 'up to 500 EUR' }], activeUntil: '3 Dec 2026, 14:20' };
  const r = (state: Parameters<typeof EndMandate>[0]['state']) => text(<EndMandate facts={facts} state={state} onEnd={noop} onKeep={noop} />);
  it('confirm', () => {
    const s = r({ phase: 'confirm' });
    for (const x of [S13.endTitle, 'The mandate for Sales', S13.endAtOnce, S13.endFinal, 'up to 500 EUR', '3 Dec 2026, 14:20', S13.endNoTouch, S13.endButtonNamed('Sales'), S13.endKeep]) expect(s).toContain(x);
    expect(s).not.toContain('Touch ID to give');
  });
  it('UI review (DEC-88): the effect in a warning box, the safe option above, the destructive one in the outline style and naming what ends', () => {
    const html = renderToStaticMarkup(<EndMandate facts={facts} state={{ phase: 'confirm' }} onEnd={noop} onKeep={noop} />);
    expect(html).toMatch(/class="warn-box"[^]*Your AI stops using it at once/);
    expect(html.indexOf('data-testid="end-keep"')).toBeLessThan(html.indexOf('data-testid="end-confirm"'));
    expect(html).toMatch(/class="btn btn-outline-strong"[^>]*data-testid="end-confirm"[^>]*>End the mandate for Sales</);
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

describe('screen 2: identity codes at the join (DEC-73, typed codes)', () => {
  const facts = { memberName: 'Dana Berg', adminName: 'Anna Muster', teamName: 'Muster GmbH', yourCode: '731422085561094233750001' };
  const view = (role: 'admin' | 'member', state: JoinState, over: Partial<typeof facts & { anchor: 'none' | 'ok' | 'invalid' }> = {}, typed = '') =>
    <JoinCompare role={role} facts={{ ...facts, ...over }} state={state} typed={typed} onType={noop} onCheck={noop} onSign={noop} />;
  it('groups a code in fours', () => expect(groupCode('73142208556109423375')).toBe('7314 2208 5561 0942 3375'));
  it('admin screen: own code, a field for the member\'s code, nothing the gateway did not answer', () => {
    const s = text(view('admin', { phase: 'compare' }));
    for (const x of [S13.joinAdminTitle('Dana Berg', 'Muster GmbH'), S13.joinAdminIntro('Dana Berg'), S13.joinNameNotChecked('Dana Berg'), S13.joinYourCode, '7314 2208 5561 0942 3375 0001', S13.joinAdminRead('Dana Berg'), S13.joinAdminType('Dana Berg'), S13.joinCheck]) expect(s).toContain(x);
    expect(s).not.toContain(S13.joinAddButton('Dana Berg'));
  });
  it('member screen: own code first, the admin\'s code is typed, the touch is not offered yet', () => {
    const s = text(view('member', { phase: 'compare' }));
    for (const x of [S13.joinMemberTitle('Anna Muster'), S13.joinMemberIntro('Muster GmbH', 'Anna Muster'), S13.joinMemberRead('Muster GmbH', 'Anna Muster'), S13.joinMemberType('Anna Muster'), S13.joinCheck]) expect(s).toContain(x);
    expect(s).not.toContain(S13.joinMemberTrust('Anna Muster'));
    expect(renderToStaticMarkup(view('member', { phase: 'compare' }))).toContain('inputMode="numeric"');
  });
  it('a wrong code shows the design text and the tries left, on each side', () => {
    expect(text(view('member', { phase: 'wrong', triesLeft: 2 }))).toContain(`${S13.joinWrongMember} ${S13.joinTriesLeft(2)}`);
    expect(text(view('admin', { phase: 'wrong', triesLeft: 1 }))).toContain(`${S13.joinWrongAdmin('Dana Berg')} 1 try left.`);
  });
  it('three wrong codes close the side with the signed-off texts and offer no field', () => {
    const m = renderToStaticMarkup(view('member', { phase: 'locked' }));
    expect(text(view('member', { phase: 'locked' }))).toBe(`${S13.joinTriesUsed} ${S13.joinMemberDifferResult}`);
    expect(text(view('admin', { phase: 'locked' }))).toBe(`${S13.joinTriesUsed} ${S13.joinDifferResult('Dana Berg')}`);
    expect(m).not.toContain('<input');
  });
  it('member: after the right code the touch button names the admin, and the touch is explained', () => {
    const s = text(view('member', { phase: 'matched' }));
    expect(s).toContain(S13.joinMemberTrust('Anna Muster')); expect(s).toContain(S13.joinMemberTouchNote);
    expect(renderToStaticMarkup(view('member', { phase: 'matched' }))).not.toContain('<input');
  });
  it('admin: the Add button stays OFF until the member\'s anchor is there and verified', () => {
    const off = renderToStaticMarkup(view('admin', { phase: 'matched' }, { anchor: 'none' }));
    expect(off).toMatch(/data-testid="join-sign"[^>]*disabled/); expect(text(view('admin', { phase: 'matched' }, { anchor: 'none' }))).toContain(S13.joinAnchorWaiting('Dana Berg'));
    const bad = renderToStaticMarkup(view('admin', { phase: 'matched' }, { anchor: 'invalid' }));
    expect(bad).toMatch(/data-testid="join-sign"[^>]*disabled/); expect(text(view('admin', { phase: 'matched' }, { anchor: 'invalid' }))).toContain(S13.joinAnchorInvalid('Dana Berg'));
    const on = renderToStaticMarkup(view('admin', { phase: 'matched' }, { anchor: 'ok' }));
    expect(on).not.toMatch(/data-testid="join-sign"[^>]*disabled/); expect(text(view('admin', { phase: 'matched' }, { anchor: 'ok' }))).toContain(S13.joinAddButton('Dana Berg'));
  });
  it('while the touch is asked for, nothing can be pressed twice', () => {
    expect(renderToStaticMarkup(view('admin', { phase: 'touch' }, { anchor: 'ok' }))).toMatch(/data-testid="join-sign"[^>]*disabled/);
    expect(renderToStaticMarkup(view('member', { phase: 'checking' }, {}, '4721'))).toMatch(/data-testid="join-check"[^>]*disabled/);
  });
  it('a failed touch keeps the match and says so; a failed check says why', () => {
    const s = text(view('member', { phase: 'error', text: S13.joinErrTouch, matched: true }));
    expect(s).toContain(S13.joinErrTouch); expect(s).toContain(S13.joinMemberTrust('Anna Muster'));
    const c = renderToStaticMarkup(view('member', { phase: 'error', text: S13.joinErrOffline }));
    expect(c).toContain('<input'); expect(text(view('member', { phase: 'error', text: S13.joinErrOffline }))).toContain(S13.joinErrOffline);
  });
  it('results', () => {
    expect(text(view('admin', { phase: 'done' }))).toBe(S13.joinAdminDone('Dana Berg'));
    expect(text(view('member', { phase: 'waiting' }))).toBe(S13.joinWaiting('Anna Muster'));
    expect(text(view('member', { phase: 'done' }))).toBe(S13.joinMemberDone('Muster GmbH', 'Anna Muster'));
  });
  it('gateway codes become sentences; an unknown code is the plain "did not work"', () => {
    expect(joinErrorText('check_failed')).toBe(S13.joinErrTouch);
    expect(joinErrorText('as_unreachable')).toBe(S13.joinErrOffline);
    expect(joinErrorText('LIST_HEAD_MOVED')).toBe(S13.joinErrMoved);
    expect(joinErrorText('no_member_list')).toBe(S13.joinErrTrust);
    expect(joinErrorText('member_has_no_chain', 'Dana Berg')).toBe(S13.joinErrNoChain('Dana Berg'));
    expect(joinErrorText('whatever')).toBe(S13.joinErrOther);
  });
  it('no word of the old terms in the join texts', () => {
    const all = [S13.joinYourCode, S13.joinCheck, S13.joinWrongMember, S13.joinMemberTouchNote, S13.joinAddButton('A'), S13.joinMemberTrust('A'), S13.joinErrOther, S13.joinAdminRead('A')].join(' ');
    for (const w of [/\bagent\b/i, /\bSP\b/, /Authority Server/, /fingerprint/i]) expect(all).not.toMatch(w);
  });
  it('colleagues list', () => {
    const s = text(<ColleagueList adminName="Anna Muster" colleagues={[{ name: 'Ben Huber', confirmedBy: 'Anna Muster' }, { name: 'Anna Muster', confirmedBy: 'you' }]} />);
    for (const x of [S13.colleaguesTitle, 'confirmed by Anna Muster', S13.confirmedByYou, S13.colleaguesWhy('Anna Muster')]) expect(s).toContain(x);
  });
});

describe('the join routes (DEC-73 step 4 wiring)', () => {
  const answer = (status: number, body: unknown) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  afterEach(() => { vi.restoreAllMocks(); });
  it('member check: posts only the typed code to the gateway\'s own route, and passes the answer on', async () => {
    const spy = answer(200, { ok: true, match: false, triesLeft: 2 });
    const r = await spClient.memberJoin.check('t 1', '4721 8830');
    expect(r).toMatchObject({ ok: true, match: false, triesLeft: 2 });
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe('/api/team-join/member/t%201/check');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ code: '4721 8830' });
  });
  it('a refusal is a code, not a throw; tries used keeps its code', async () => {
    answer(423, { ok: false, code: 'tries_used', triesLeft: 0 });
    expect(await spClient.adminJoin.check('t1', 'u1', '1')).toEqual({ ok: false, code: 'tries_used', triesLeft: 0 });
  });
  it('an unreachable gateway and an answer of another shape are codes too', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network'));
    expect(await spClient.memberJoin.view('t1')).toEqual({ ok: false, code: 'as_unreachable' });
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 502 }));
    expect(await spClient.memberJoin.anchor('t1')).toEqual({ ok: false, code: 'other' });
  });
  it('the touch routes carry no body of the page\'s own choosing', async () => {
    const spy = answer(200, { ok: true, version: 3 });
    await spClient.adminJoin.add('t1', 'u1');
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe('/api/team-join/admin/t1/u1/add');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({});
  });
});

describe('the held-back, preview and change routes (step 13 wiring)', () => {
  const answer = (status: number, body: unknown) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  afterEach(() => { vi.restoreAllMocks(); });

  it('held-back: reads the gateway\'s verdicts; null when it cannot say (no chain, error); the call is a plain GET', async () => {
    const spy = answer(200, { held: [{ authorizationId: 'a', mandateId: 'm', code: 'mandate_body_not_received', profileName: 'Sales', ownerIsYou: true, ownerName: null, adminName: null }] });
    const r = await spClient.getHeldBack();
    expect(r?.[0]).toMatchObject({ code: 'mandate_body_not_received', profileName: 'Sales' });
    expect(String(spy.mock.calls[0][0])).toContain('/api/mandate/held-back');
    expect(spy.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
    answer(409, { code: 'not_set_up' });
    expect(await spClient.getHeldBack()).toBeNull();
  });

  it('preview: the diff and team terms from the gateway; its refusals become codes', async () => {
    const spy = answer(200, { profileName: 'Sales', diff: baseDiff, before: null, after: null });
    const r = await spClient.previewMandateChange('authz_x', { durationHours: 5 });
    expect(r).toMatchObject({ ok: true, profileName: 'Sales' });
    expect(String(spy.mock.calls[0][0])).toContain('/api/mandate/change-preview?authorizationId=authz_x&changes=');
    answer(422, { code: 'no_change' });
    expect(await spClient.previewMandateChange('authz_x', {})).toEqual({ ok: false, code: 'no_change' });
    answer(500, {});
    expect(await spClient.previewMandateChange('authz_x', {})).toEqual({ ok: false, code: 'other' });
  });

  it('change: posts the diff that was shown; a cancelled touch, a changed mandate and others map to the screen\'s codes', async () => {
    const spy = answer(200, { ok: true });
    expect(await spClient.changeMandate('authz_x', { durationHours: 5 }, baseDiff)).toEqual({ ok: true });
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body))).toEqual({ authorizationId: 'authz_x', changes: { durationHours: 5 }, sealedDiff: baseDiff });
    answer(422, { code: 'grant_refused', grantCode: 'check_failed' });
    expect(await spClient.changeMandate('authz_x', {}, baseDiff)).toEqual({ ok: false, code: 'cancelled' });
    answer(422, { code: 'changed_since_proposal' });
    expect(await spClient.changeMandate('authz_x', {}, baseDiff)).toEqual({ ok: false, code: 'changed_since_proposal' });
    answer(500, {});
    expect(await spClient.changeMandate('authz_x', {}, baseDiff)).toEqual({ ok: false, code: 'other' });
  });
});

describe('screen 1: give a mandate (review step, chain accounts)', () => {
  const people = [{ userId: 'u1', name: 'Ben Huber' }, { userId: 'u2', name: 'Carla Weiss' }, { userId: 'me', name: 'Me' }];
  const list = (unconfirmed: string[] | null) => approverLines(people, unconfirmed === null ? null : new Set(unconfirmed));
  const view = (unconfirmed: string[] | null) => text(<GiveApprovers capText="500 EUR" count={2} approvers={list(unconfirmed)} adminName="Anna Muster" ownId="me" />);
  it('names the cap, the count and the people; your own row explains', () => {
    const s = view(['u2']);
    expect(s).toContain('Above 500 EUR, 2 of these people must approve first:');
    expect(s).toContain('Ben Huber'); expect(s).toContain('confirmed by Anna Muster'); expect(s).toContain('not confirmed by your admin yet');
    expect(s).toContain(S13.giveYouNote);
  });
  it('an unconfirmed approver blocks with the reason and one next step', () => {
    expect(view(['u2'])).toContain('Carla Weiss is not confirmed by your admin yet. They cannot approve until Anna Muster confirms them. Ask Anna Muster to confirm them.');
    expect(giveBlocked(list(['u2']), 'me')).toBe(true);
    expect(giveBlocked(list([]), 'me')).toBe(false);
    expect(giveBlocked(list(['me']), 'me')).toBe(false);
  });
  it('before the first give nothing is claimed as confirmed (interim source)', () => {
    const s = view(null);
    expect(s).not.toContain('confirmed by Anna'); expect(s).toContain(S13.giveApproversChecked); expect(giveBlocked(list(null), 'me')).toBe(false);
  });
  it('limits show profile labels and units', () => {
    const schema = { fields: { amount: { displayName: 'Value of one offer', unit: 'currency:EUR' }, per_day: { displayName: 'Offers per day', unit: 'count' } } };
    expect(limitRows({ profile: 'x', amount: 500, per_day: 10, other: 3 }, schema)).toEqual([
      { key: 'amount', label: 'Value of one offer', value: '€500' }, { key: 'per_day', label: 'Offers per day', value: '10' }, { key: 'other', label: 'other', value: '3' }]);
    expect(limitValueText({ unit: 'percent' }, 5)).toBe('5%');
  });
  it('end date next to the duration', () => {
    expect(durationText(14 * 86400)).toBe('14 days'); expect(durationText(3600)).toBe('1 hour');
    expect(endDateText(Date.UTC(2026, 10, 19, 12), 86400)).toMatch(/2026/);
    expect(S13.giveUntil('14 days', '3 Dec 2026, 14:20')).toBe('14 days (until 3 Dec 2026, 14:20)');
    expect(S13.giveDone('Sales', '3 Dec 2026, 14:20')).toBe('Done. The mandate for Sales is active until 3 Dec 2026, 14:20.');
  });
  it('refusals map to the mockup texts 218 to 224', () => {
    expect(giveErrorText({ code: 'cap_exceeded' })).toBe(S13.giveErrCap);
    expect(giveErrorText({ code: 'approvers_unavailable' })).toBe(S13.giveErrApprovers);
    expect(giveErrorText({ code: 'as_unreachable' })).toBe(S13.endOffline);
    expect(giveErrorText({ code: 'approver_has_no_chain' })).toBe(S13.giveErrNoChain);
    // the approvers are named when the page knows them
    expect(giveErrorText({ code: 'approver_has_no_chain', approverNames: ['Colleague'] })).toBe('Colleague has not finished setting up Suveren yet. Nothing changed. Ask them to finish it.');
    expect(giveErrorText({ code: 'approver_has_no_chain', approverNames: ['Ben', 'Cara', 'Dora'] })).toMatch(/^Ben, Cara and Dora have not finished setting up Suveren yet/);
    expect(giveErrorText({ code: 'approver_has_no_chain', approverNames: [] })).toBe(S13.giveErrNoChain);
    expect(giveErrorText({ code: 'check_failed', reason: 'user_cancelled' })).toBe(S13.giveErrCancelled);
    expect(giveErrorText({ code: 'check_failed', reason: 'check_failed' })).toBe(S13.giveErrTouch);
    expect(giveErrorText({ code: 'delivery_failed' })).toBe(S13.giveErrNotDelivered);
    expect(giveErrorText({ code: 'grant_not_recorded' })).toBe(S13.giveErrNotAccepted);
  });
  it('the sign route keeps the old message and adds the code', async () => {
    const { MandateSignError } = await import('../../lib/sp-client');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'mandate_refused', message: 'nope', code: 'grant_refused', grantCode: 'cap_exceeded' }), { status: 422, headers: { 'content-type': 'application/json' } }));
    const err = await spClient.signMandate({ team: 'personal', profile: 'p', limits: {}, scope: {}, intent: 'i', mode: 'review', ttlSeconds: 1, title: 't', discloseIdentity: false }).catch(e => e);
    expect(err).toBeInstanceOf(MandateSignError); expect(err).toBeInstanceOf(Error); expect(err.code).toBe('cap_exceeded');
    vi.restoreAllMocks();
  });
});

describe('prepare (the gateway\'s checked plan) and the bound give', () => {
  const answer = (status: number, body: unknown) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  afterEach(() => { vi.restoreAllMocks(); });

  it('prepare posts the request as it would be given and returns the gateway\'s plan; a refusal is the gateway\'s own message', async () => {
    const plan = { planHash: 'sha256:x', profileId: 'sales@0.4', profileName: 'Sales', profileHash: 'sha256:p', mode: 'review', ttlSeconds: 3600, expiresAt: 1, bounds: [], scope: [], intent: 'why', team: null, blocked: null };
    const spy = answer(200, plan);
    const r = await spClient.prepareMandate({ team: 'personal', profile: 'sales' });
    expect(r).toEqual({ ok: true, prepared: plan });
    expect(String(spy.mock.calls[0][0])).toContain('/api/mandate/prepare');
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body))).toEqual({ team: 'personal', profile: 'sales' });
    answer(422, { code: 'mandate_refused', message: 'Unknown field' });
    expect(await spClient.prepareMandate({})).toMatchObject({ ok: false });
  });

  it('the give echoes the plan hash; a changed plan has its own sentence', async () => {
    const spy = answer(200, { authorizationId: 'a' });
    await spClient.signMandate({ team: 'personal', profile: 'p', limits: {}, scope: {}, intent: 'i', mode: 'review', ttlSeconds: 1, title: 't', discloseIdentity: false, planHash: 'sha256:abc' });
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body)).planHash).toBe('sha256:abc');
    expect(giveErrorText({ code: 'changed_since_prepare' })).toBe(S13.giveErrChanged);
    expect(giveErrorText({ code: 'prepare_required' })).toBe(S13.giveErrChanged);
  });

  it('approver states come from the gateway\'s plan: before it answers nothing is known, then confirmed or unconfirmed', () => {
    const lines = (ids: Set<string> | null) => approverLines([{ userId: 'a', name: 'Anna' }, { userId: 'b', name: 'Bernd' }], ids).map(l => l.state);
    expect(lines(null)).toEqual(['unknown', 'unknown']);
    expect(lines(new Set(['b']))).toEqual(['confirmed', 'unconfirmed']);
  });
});

describe('on hold is never also Active (one source for the list and the cards)', () => {
  it('only a give on its way and an ended mandate stay out of the held set', async () => {
    const { isHeldShown } = await import('./HeldBackHost');
    for (const r of ['alarm', 'rules_changed', 'touch_missing', 'unknown', 'waiting_confirm'] as const) expect(isHeldShown(r)).toBe(true);
    expect(isHeldShown('not_received')).toBe(false); expect(isHeldShown('ended')).toBe(false);
  });
});
