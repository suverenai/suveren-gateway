/**
 * Shipped-manifest audit: an omitted write argument can never leave a scope
 * field unchecked by surprise.
 *
 * For every write tool of a shipped manifest, every scope field (any version
 * of the tool's profile) that the executionMapping fills must be filled on
 * every call: by the manifest's staticExecution, by an argument the
 * connector's own input schema REQUIRES, or by an argument with a declared
 * `argDefaults` value (the connector's own default, sent explicitly). An
 * argument that does none of these is refused at runtime under a mandate
 * whose scope constrains its field (tool-proxy.ts `fieldsLeftByAbsentArgs`) —
 * listed below as a known finding, so the list can only shrink.
 *
 * Connector schemas: fixtures/connector-schemas/<id>.json, captured from the
 * pinned versions by scripts/capture-connector-schemas.mjs. Profiles:
 * SUVEREN_PROFILES_DIR (else the sibling hap-profiles).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const MANIFESTS = join(ROOT, 'content', 'integrations');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'connector-schemas');
const PROFILES_DIR = process.env.SUVEREN_PROFILES_DIR ?? join(ROOT, '..', 'hap-profiles');

type Json = Record<string, any>;
const readJson = (p: string): Json => JSON.parse(readFileSync(p, 'utf8'));

function scopeFields(family: string): Set<string> {
  const dir = join(PROFILES_DIR, family);
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.profile.json'))) {
    for (const k of Object.keys(readJson(join(dir, f)).scopeSchema?.fields ?? {})) out.add(k);
  }
  return out;
}

function audit(): { findings: string[]; problems: string[]; audited: string[]; unverifiable: string[] } {
  const unverifiable: string[] = [];
  const findings: string[] = [];
  const problems: string[] = [];
  const audited: string[] = [];
  for (const file of Object.values(readJson(join(MANIFESTS, 'index.json')).integrations as Record<string, string>)) {
    const m = readJson(join(MANIFESTS, file));
    for (const [tool, o] of Object.entries((m.toolGating?.overrides ?? {}) as Record<string, Json | null>)) {
      if (!o || o.category === 'read' || o.category === 'disabled' || o.internal) continue;
      const scope = scopeFields((o.profile ?? m.profile) as string);
      const producers = new Map<string, string[]>();
      for (const [arg, mapping] of Object.entries((o.executionMapping ?? {}) as Record<string, unknown>)) {
        for (const e of Array.isArray(mapping) ? mapping : [mapping]) {
          const field = typeof e === 'string' ? e : (e as { field: string }).field;
          if (scope.has(field)) producers.set(field, [...(producers.get(field) ?? []), arg]);
        }
      }
      if (producers.size === 0) continue;
      // A remote connector (mcp-remote proxy) cannot be captured offline: its
      // schema is unknown here. Named, so the gap stays visible.
      if (m.mcp?.command === 'mcp-remote') { unverifiable.push(`${m.id}.${tool}`); continue; }
      const fixturePath = join(FIXTURES, `${m.id}.json`);
      if (!existsSync(fixturePath)) { problems.push(`${m.id}.${tool}: maps a scope field, but no schema fixture ${m.id}.json`); continue; }
      const fx = readJson(fixturePath);
      if (fx.npmVersion !== m.npmVersion) { problems.push(`${m.id}: fixture captured from ${fx.npmVersion}, manifest pins ${m.npmVersion}`); continue; }
      const schema = fx.tools?.[tool];
      if (!schema) { problems.push(`${m.id}.${tool}: no such tool in the fixture`); continue; }
      audited.push(`${m.id}.${tool}`);
      const required = new Set<string>(schema.required ?? []);
      const defaults = (o.argDefaults ?? {}) as Record<string, unknown>;
      const fixed = (o.staticExecution ?? {}) as Record<string, unknown>;
      for (const [field, args] of producers) {
        if (field in fixed) continue;
        if (args.some(a => required.has(a) || a in defaults)) continue;
        for (const a of args) findings.push(`${m.id}.${tool}[${a}] -> ${field}`);
      }
    }
  }
  return { findings: [...new Set(findings)].sort(), problems, audited, unverifiable };
}

describe('shipped manifests: an omitted write argument never leaves a scope field silently unchecked', () => {
  const { findings, problems, audited, unverifiable } = audit();

  it('names the remote connectors whose schema cannot be checked offline', () => {
    // Mollie's hosted MCP: whether `currency` / `amount_currency` is required is
    // not known here. At runtime an omitted one is refused under a mandate whose
    // currency scope is set (every charge mandate sets it).
    expect(unverifiable).toEqual(['mollie.CreatePayment', 'mollie.CreatePaymentLink', 'mollie.CreateCapture']);
  });

  it('has the fixtures and profiles it needs', () => {
    expect(existsSync(PROFILES_DIR), `profiles not found at ${PROFILES_DIR} (set SUVEREN_PROFILES_DIR)`).toBe(true);
    expect(problems).toEqual([]);
  });

  it('audits the tools it is supposed to', () => {
    for (const t of ['mail.send_message', 'linkedin.create_post', 'calendar.create_event', 'calendar.update_event', 'calendar.delete_event']) {
      expect(audited, `${t} should be audited`).toContain(t);
    }
  });

  // Each is REFUSED at runtime when the mandate's scope constrains the field
  // and the call omits the argument (the AI is told to state it). Not given a
  // default because omitting it does not mean one fixed value.
  const KNOWN_REFUSED_WHEN_OMITTED = [
    // update_event without attendees keeps the event's current attendees — no
    // single value; sending [] would remove them. The AI states them.
    'calendar.update_event[attendees] -> allowed_attendees',
    'calendar.update_event[attendees] -> allowed_domains',
  ];

  it('every scope field is filled by a required argument, a declared default or staticExecution — except the known findings', () => {
    expect(findings).toEqual([...KNOWN_REFUSED_WHEN_OMITTED].sort());
  });
});
