/**
 * The shipped-manifest audit for the sealed-args rule (sealed-args.ts).
 *
 * For every tool a shipped manifest sells as a content-sealed write, under EVERY
 * version of its profile that seals content, every argument the connector's
 * schema offers must be bound, a declared reference, or declared `nonContentArgs`.
 * A new connector release that adds an argument — the next `threadId` — fails
 * here until somebody classifies it, instead of silently changing what goes out.
 *
 * The connectors' schemas come from fixtures/connector-schemas/<id>.json,
 * captured from the PINNED npm versions by scripts/capture-connector-schemas.mjs;
 * a fixture whose version differs from the manifest pin fails (stale capture).
 * Profiles come from SUVEREN_PROFILES_DIR (else the sibling hap-profiles).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifySealedArgs, type SealedArgsGating } from '../src/lib/sealed-args';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const MANIFESTS = join(ROOT, 'content', 'integrations');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'connector-schemas');
const PROFILES_DIR = process.env.SUVEREN_PROFILES_DIR ?? join(ROOT, '..', 'hap-profiles');

type Json = Record<string, any>;
const readJson = (p: string): Json => JSON.parse(readFileSync(p, 'utf8'));

interface ProfileVersion { family: string; version: string; binding: any }
function profileVersions(family: string): ProfileVersion[] {
  const dir = join(PROFILES_DIR, family);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.profile.json')).sort().map(f => ({
    family, version: f.replace('.profile.json', ''), binding: readJson(join(dir, f)).content_binding,
  }));
}

const manifestIds = Object.values((readJson(join(MANIFESTS, 'index.json')).integrations) as Record<string, string>);

/** The audit table: one row per (connector, sealed tool, profile version, argument). */
interface Row { connector: string; tool: string; profile: string; arg: string; cls: string }
function audit(): { rows: Row[]; problems: string[] } {
  const rows: Row[] = [];
  const problems: string[] = [];
  for (const file of manifestIds) {
    const m = readJson(join(MANIFESTS, file));
    const overrides = (m.toolGating?.overrides ?? {}) as Record<string, Json | null>;
    for (const [tool, o] of Object.entries(overrides)) {
      if (!o || o.category === 'read' || o.category === 'disabled' || o.internal) continue;
      const family = (o.profile ?? m.profile) as string;
      const gating: SealedArgsGating = o;
      const sealedUnder = profileVersions(family).filter(v => classifySealedArgs(gating, v.binding).sealed);
      if (sealedUnder.length === 0) continue;
      const fixturePath = join(FIXTURES, `${m.id}.json`);
      if (!existsSync(fixturePath)) { problems.push(`${m.id}.${tool}: sealed under ${family}, but no schema fixture ${m.id}.json (run scripts/capture-connector-schemas.mjs)`); continue; }
      const fx = readJson(fixturePath);
      if (fx.npmVersion !== m.npmVersion) { problems.push(`${m.id}: fixture captured from ${fx.npmVersion}, manifest pins ${m.npmVersion} (re-capture)`); continue; }
      const schema = fx.tools?.[tool];
      if (!schema) { problems.push(`${m.id}.${tool}: sealed under ${family}, but the connector offers no such tool in the fixture`); continue; }
      const blocked: string[] = o.blockedArgs ?? [];
      for (const v of sealedUnder) {
        const c = classifySealedArgs(gating, v.binding);
        for (const arg of Object.keys(schema.properties ?? {})) {
          if (blocked.includes(arg)) continue;
          rows.push({ connector: m.id, tool, profile: `${family}@${v.version}`, arg, cls: c.classes.get(arg) ?? 'UNCLASSIFIED' });
        }
      }
    }
  }
  return { rows, problems };
}

describe('shipped manifests: every argument of a sealed tool is classified', () => {
  const { rows, problems } = audit();

  it('has the profiles and fixtures it needs', () => {
    expect(existsSync(PROFILES_DIR), `profiles not found at ${PROFILES_DIR} (set SUVEREN_PROFILES_DIR)`).toBe(true);
    expect(problems).toEqual([]);
  });

  it('audits the tools it is supposed to (guards against a silently empty audit)', () => {
    const tools = new Set(rows.map(r => `${r.connector}.${r.tool}`));
    for (const t of ['mail.send_message', 'linkedin.create_post', 'deploy-github.release']) {
      expect(tools.has(t), `${t} should be audited`).toBe(true);
    }
  });

  // Findings of the 2026-11-06 audit, each REFUSED at runtime (never silently
  // allowed). Every entry changes what is sent (or, for ids, which content is
  // sent) without being bound by the profile. The list may only shrink by
  // fixing the cause — bind it in the profile, or, if it truly changes nothing
  // sent, declare it `nonContentArgs` in the manifest — and it fails when an
  // entry stops being unclassified, so it cannot go stale.
  // Explicitly blocked in the gmail manifest (blockedArgs, decided by Andreas 2026-11-06): threadId (the
  // connector adds a subject + quote of its own), bcc (hidden recipients), includeBodyHtml (format),
  // send_draft.id (a draft is not bound). Only unclassified-by-version findings remain below.
  const KNOWN_REFUSED = [
    'linkedin.create_article_post[articleUrl]',   // publish@0.4-0.7 only (they bind the text only); bound from publish@0.8
    'linkedin.create_article_post[description]',  // publish@0.4-0.7 only
    'linkedin.create_article_post[title]',        // publish@0.4-0.7 only
    'linkedin.create_image_post[altText]',        // publish@0.4-0.7 only
    'linkedin.create_image_post[imagePath]',      // publish@0.4-0.7 only; the file NAME is bound from 0.8, not its bytes
    'linkedin.create_image_post[imageUrl]',       // publish@0.4-0.7 only; the URL is bound from 0.8, not the image bytes
    'mail.send_message[cc]',                      // email@0.4 only — mapped for count/scope, but sealedOnlyArgs keeps the refusal
    'mail.send_message[subject]',                 // email@0.4 only
  ];

  it('seals the post media under publish@0.8 (checked against a pinned copy of that profile)', () => {
    // A copy of hap-profiles publish/0.8.profile.json (PR hap-profiles#22): CI reads the catalog
    // from hap-profiles MAIN, which gets 0.8 only when gateway + profile are merged together.
    const p08 = readJson(join(import.meta.dirname, 'fixtures', 'profile-fixtures', 'publish-0.8.profile.json')).content_binding;
    const linkedin = readJson(join(MANIFESTS, 'linkedin.json'));
    for (const [tool, args] of [['create_image_post', ['imageUrl', 'imagePath', 'altText']], ['create_article_post', ['articleUrl', 'title', 'description']]] as const) {
      const c = classifySealedArgs(linkedin.toolGating.overrides[tool], p08);
      for (const a of args) expect(c.classes.get(a), `${tool}[${a}] under publish@0.8`).toBe('bound');
    }
    // ...and an older publish mandate still refuses them (it must be signed again).
    const cls = (c: string, t: string, v: string, a: string) =>
      rows.find(r => r.connector === c && r.tool === t && r.profile === v && r.arg === a)?.cls;
    expect(cls('linkedin', 'create_image_post', 'publish@0.7', 'imageUrl')).toBe('UNCLASSIFIED');
  });

  it('leaves no argument unclassified except the known, refused findings', () => {
    const unclassified = [...new Set(rows.filter(r => r.cls === 'UNCLASSIFIED').map(r => `${r.connector}.${r.tool}[${r.arg}]`))].sort();
    expect(
      unclassified,
      'A sealed tool offers an argument nobody classified. Add it to the tool\'s `nonContentArgs` if it truly changes nothing that is sent, to `blockedArgs` if it must never be used, or bind it in the profile. Refused at runtime until then.',
    ).toEqual([...KNOWN_REFUSED].sort());
  });
});
