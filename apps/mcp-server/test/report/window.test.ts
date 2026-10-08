/**
 * The reporting window (src/lib/report/window.ts, RR2): how it is resolved
 * from the held reporting mandates, its edges, the simulation load-time clamp,
 * the refusal of reporting@0.1 mandates, and that a window-scoped archive / export really
 * hides everything outside it.
 *
 * Profiles are read from the REAL hap-profiles checkout (SUVEREN_PROFILES_DIR,
 * as the other report tests do): reporting@0.2 declares the window bound,
 * reporting@0.1 does not — the code must tell them apart from the schema, not
 * from the version string.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerProfile, validateProfile, type AgentProfile } from '@hap/core';
import {
  resolveReportWindow, windowArchive, windowExport, scopeReportSources, isInWindow,
  END_SKEW_SECONDS, OUTSIDE_WINDOW_PREFIX, type WindowAuthorization,
} from '../../src/lib/report/window';
import { buildScenario } from './fixtures/scenario';
import { buildEmailExport } from './fixtures/exports';

const profilesDir =
  process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', '..', 'hap-profiles');
const R01 = JSON.parse(readFileSync(join(profilesDir, 'reporting/0.1.profile.json'), 'utf8'));
const R02 = JSON.parse(readFileSync(join(profilesDir, 'reporting/0.2.profile.json'), 'utf8'));

beforeAll(() => {
  registerProfile(R01.id, R01);
  registerProfile(R02.id, R02);
});

const DAY = 86_400;
const NOW = 1_900_000_000;

function mandate(profileId: string, bounds: Record<string, string | number>, complete = true): WindowAuthorization {
  return { profileId, bounds, complete };
}
const m02 = (days: number) => mandate(R02.id, { profile: R02.id, read_access: 'unlimited', read_max_age_days: days, report_daily_max: 5 });
const m01 = () => mandate(R01.id, { profile: R01.id, read_access: 'unlimited', report_daily_max: 5 });

describe('resolveReportWindow', () => {
  it('reporting@0.2: window = [now − N days, now]', () => {
    const r = resolveReportWindow({ authorizations: [m02(30)], simulation: false, loadedAt: null, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.window.start).toBe(NOW - 30 * DAY);
    expect(r.window.end).toBe(NOW);
    expect(r.window.days).toBe(30);
    expect(r.window.label).toMatch(/last 30 days/);
  });

  it("clamps to the profile's maximum (366), never wider than the profile allows", () => {
    const r = resolveReportWindow({ authorizations: [m02(5000)], simulation: false, loadedAt: null, now: NOW });
    expect(r.ok && r.window.start).toBe(NOW - 366 * DAY);
  });

  it('simulation mode: never earlier than the test-data load time', () => {
    const loadedAt = NOW - 2 * 3600;
    const r = resolveReportWindow({ authorizations: [m02(30)], simulation: true, loadedAt, now: NOW });
    expect(r.ok && r.window.start).toBe(loadedAt);
    expect(r.ok && r.window.label).toMatch(/test data was loaded/);
  });

  it('simulation mode: a load time older than the lookback does not widen the window', () => {
    const loadedAt = NOW - 90 * DAY;
    const r = resolveReportWindow({ authorizations: [m02(30)], simulation: true, loadedAt, now: NOW });
    expect(r.ok && r.window.start).toBe(NOW - 30 * DAY);
  });

  it('outside simulation mode the load time is ignored', () => {
    const r = resolveReportWindow({ authorizations: [m02(30)], simulation: false, loadedAt: NOW - 3600, now: NOW });
    expect(r.ok && r.window.start).toBe(NOW - 30 * DAY);
  });

  it('REFUSAL: reporting@0.1 (no window bound in its profile) is refused — in simulation mode too, even with a known load time', () => {
    for (const [simulation, loadedAt] of [[false, null], [true, null], [true, NOW - 3600]] as const) {
      const r = resolveReportWindow({ authorizations: [m01()], simulation, loadedAt, now: NOW });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('This reporting mandate is from an older profile version — create a new reporting mandate.');
      expect(r.reason).not.toMatch(/simulat/i); // agent-facing (report.ts rule)
    }
  });

  // v0.7 regression: this refusal used to point at a HARDCODED version
  // ("...create a new reporting mandate (reporting@0.2)."). The v0.7 switch
  // proved exactly why that is fragile: reporting@0.2 itself is no longer
  // issuable (its requiredGates still names the retired `decision_owner`
  // gate -- hap-core's validateProfile refuses it, PROFILE_INVALID) once
  // hap-profiles' v0.7 versions are live, so a message naming it as "the"
  // fix would send someone to create a mandate the AS would then refuse.
  // The message must never name a specific version.
  it('the refusal never names a hardcoded profile version (one that itself could go stale)', () => {
    const r = resolveReportWindow({ authorizations: [m01()], simulation: false, loadedAt: null, now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).not.toMatch(/@\d+\.\d+/);
    // Demonstrates why: reporting@0.2 (what the old message pointed at) is
    // itself PROFILE_INVALID under v0.7 -- never a safe thing to hardcode.
    const errors = validateProfile(R02 as AgentProfile);
    expect(errors.some((e) => e.message.includes('decision_owner'))).toBe(true);
  });

  it('REFUSAL: no reporting mandate (or only an incomplete one, or another profile)', () => {
    for (const auths of [[], [mandate(R02.id, { read_max_age_days: 30 }, false)], [mandate('github.com/x/sales@0.3', { read_max_age_days: 30 })]]) {
      const r = resolveReportWindow({ authorizations: auths, simulation: false, loadedAt: null, now: NOW });
      expect(r.ok).toBe(false);
    }
  });

  it('REFUSAL: a reporting@0.2 mandate without the window bound is not "all history"', () => {
    const r = resolveReportWindow({ authorizations: [mandate(R02.id, { read_access: 'unlimited' })], simulation: false, loadedAt: null, now: NOW });
    expect(r.ok).toBe(false);
  });

  it('several mandates: the most permissive (earliest start) wins, as with read_max_age_days on reads', () => {
    const r = resolveReportWindow({ authorizations: [m02(7), m02(30), m01()], simulation: false, loadedAt: null, now: NOW });
    expect(r.ok && r.window.start).toBe(NOW - 30 * DAY);
  });
});

describe('window edges', () => {
  const w = { start: NOW - 30 * DAY, end: NOW, days: 30, loadedAt: null, label: 'x' };
  it('start is inclusive, one second earlier is out', () => {
    expect(isInWindow(w.start, w)).toBe(true);
    expect(isInWindow(w.start - 1, w)).toBe(false);
  });
  it('the end allows a small clock skew, nothing beyond', () => {
    expect(isInWindow(NOW, w)).toBe(true);
    expect(isInWindow(NOW + END_SKEW_SECONDS, w)).toBe(true);
    expect(isInWindow(NOW + END_SKEW_SECONDS + 1, w)).toBe(false);
  });
  it('no timestamp → outside (fail closed)', () => {
    expect(isInWindow(undefined, w)).toBe(false);
    expect(isInWindow(Number.NaN, w)).toBe(false);
  });
});

describe('windowArchive', () => {
  it('hides tickets outside the window and the mandates only they ran under, and says why a hidden one is missing', () => {
    const { archive, addTicket } = buildScenario();
    const w = { start: NOW - 30 * DAY, end: NOW, days: 30, loadedAt: null, label: 'since then (the last 30 days)' };
    addTicket({ id: 'old', action: 'a', authorizationId: 'authz-old', timestamp: w.start - 1, authorization: { authorizationId: 'authz-old', profileId: 'p', intent: 'family calendar' } });
    addTicket({ id: 'edge', action: 'a', authorizationId: 'authz-new', timestamp: w.start, authorization: { authorizationId: 'authz-new', profileId: 'p' } });
    addTicket({ id: 'new', action: 'a', authorizationId: 'authz-new', timestamp: NOW - 10 });

    const scoped = windowArchive(archive, w);
    expect(scoped.getReceipts().map(r => r.receipt.id)).toEqual(['edge', 'new']);
    expect(scoped.getAuthorizations().map(a => a.authorizationId)).toEqual(['authz-new']);
    expect(scoped.outsideWindowReason!('old')).toContain(OUTSIDE_WINDOW_PREFIX);
    expect(scoped.outsideWindowReason!('old')).toContain('the last 30 days');
    expect(scoped.outsideWindowReason!('new')).toBeUndefined();
    expect(scoped.outsideWindowReason!('ghost')).toBeUndefined();
  });
});

describe('windowExport', () => {
  it('filters every row table by its own date; a backdated package row counts from the load time', () => {
    const loadedAt = NOW - 3600;
    const w = { start: loadedAt, end: NOW, days: 30, loadedAt, label: 'x' };
    const iso = (t: number) => new Date(t * 1000).toISOString();
    const exp = buildEmailExport({
      simulation_load: { name: 'pkg', package_sha256: 's', cases_loaded: 1, loaded_at: iso(loadedAt) },
      inbox: [
        // backdated by the package to before the load — still part of this run
        { id: 'm-backdated', from_name: 'A', from_email: 'a@x', to_json: '[]', subject: 's', body: 'b', received_at: iso(loadedAt - 3000), case_id: 'C1' },
        { id: 'm-bad-date', from_name: 'A', from_email: 'a@x', to_json: '[]', subject: 's', body: 'b', received_at: 'not a date' },
      ],
      changes: [{ id: 'ch-in', at: iso(NOW - 60), tool: 't' }],
    });
    const out = windowExport(exp, w, loadedAt) as typeof exp;
    expect(out.inbox.map(m => m.id)).toEqual(['m-backdated']);
    expect(out.changes.map(c => c.id)).toEqual(['ch-in']);
    expect(out.simulation_load).toEqual(exp.simulation_load);

    // Without the load-time rule, a row older than the window is dropped.
    const outNoLoad = windowExport(exp, w, null) as typeof exp;
    expect(outNoLoad.inbox).toEqual([]);
  });
});

describe('windowExport — rows a ticket produced, and tables with other date columns', () => {
  it('a row produced by a ticket is as old as that ticket; a CRM activity dated only by `date` is kept', () => {
    const w = { start: NOW - 30 * DAY, end: NOW, days: 30, loadedAt: null, label: 'x' };
    const sqlite = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19); // datetime('now') shape
    const exp = {
      mode: 'live',
      activities: [
        { id: 'a-new', contact_id: 'c', type: 'note', summary: 's', date: sqlite(NOW - DAY) },
        { id: 'a-by-old-ticket', contact_id: 'c', type: 'note', summary: 's', date: sqlite(NOW - 60), receipt_id: 'tk-old' },
        { id: 'a-by-new-ticket', contact_id: 'c', type: 'note', summary: 's', date: sqlite(NOW - 90 * DAY), receipt_id: 'tk-new' },
      ],
    };
    const ticketTimes = new Map([['tk-old', NOW - 40 * DAY], ['tk-new', NOW - 60]]);
    const out = windowExport(exp, w, null, ticketTimes) as typeof exp;
    expect(out.activities.map(a => a.id)).toEqual(['a-new', 'a-by-new-ticket']);
  });
});

describe('scopeReportSources', () => {
  it('reads the load time only in simulation mode, and scopes archive + exports to one window', async () => {
    const { archive, addTicket } = buildScenario();
    const now = Math.floor(Date.now() / 1000);
    const loadedAt = now - 600;
    addTicket({ id: 'before-load', action: 'a', authorizationId: 'x', timestamp: loadedAt - 1 });
    addTicket({ id: 'after-load', action: 'a', authorizationId: 'x', timestamp: loadedAt + 1 });
    let exportCalls = 0;
    const runExport = async () => {
      exportCalls++;
      return buildEmailExport({ simulation_load: { name: 'p', package_sha256: 's', cases_loaded: 0, loaded_at: new Date(loadedAt * 1000).toISOString() } });
    };

    const off = await scopeReportSources({ archive, runExport }, { authorizations: [m02(30)], simulation: false, now });
    expect(exportCalls).toBe(0);
    expect(off.ok && off.sources.archive.getReceipts().map(r => r.receipt.id)).toEqual(['before-load', 'after-load']);

    const on = await scopeReportSources({ archive, runExport }, { authorizations: [m02(30)], simulation: true, now });
    expect(on.ok && on.sources.archive.getReceipts().map(r => r.receipt.id)).toEqual(['after-load']);
    expect(on.ok && on.sources.window?.start).toBe(loadedAt);
  });
});
