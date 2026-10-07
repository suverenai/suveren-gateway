/**
 * Setup guides (simulation setup S10): defaults shipped with the gateway, an
 * override folder on top, and setup__get_guide serving them through the gate.
 *
 * - no topic is in code: the tool lists whatever files exist, in file order;
 * - an override replaces a default of the same topic and keeps its place; a new
 *   file adds a topic;
 * - every guide starts with the language rule and the systems actually connected
 *   (connectors only — built-ins are not systems);
 * - read under a delegation mandate with read_access unlimited; refused with
 *   read_access none, without a mandate, and outside simulation mode;
 * - the shipped guides are complete and short enough to read in one call.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProfile } from '@hap/core';
import { loadGuides, guideHeader, builtinGuidesDir } from '../src/lib/guides';
import { IntegrationManager } from '../src/lib/integration-manager';
import { registerBuiltins } from '../src/lib/builtins';
import { connectedSystems } from '../src/lib/builtins/setup';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { DiscoveredTool } from '../src/lib/integration-manager';

const profilesDir =
  process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');
const DELEGATION = JSON.parse(readFileSync(join(profilesDir, 'delegation', '0.1.profile.json'), 'utf8'));
beforeAll(() => registerProfile(DELEGATION.id, DELEGATION));
afterEach(() => { delete process.env.SUVEREN_SIMULATION; delete process.env.SUVEREN_GUIDES_DIR; });

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'guides-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
}

describe('loadGuides', () => {
  it('lists whatever files exist, in number order, with title and summary from the text', () => {
    const d = dir({
      '2-package.md': '# Package\n\nBuild and load the test data.\n\nBody.',
      '1-interview.md': '# Interview\n\nLearn the company.\n',
      'notes.txt': 'ignored',
      'Bad Name.md': '# ignored',
    });
    expect(loadGuides(d, undefined).map((g) => [g.topic, g.title, g.summary, g.source])).toEqual([
      ['interview', 'Interview', 'Learn the company.', 'default'],
      ['package', 'Package', 'Build and load the test data.', 'default'],
    ]);
    rmSync(d, { recursive: true, force: true });
  });

  it('an override replaces a default of the same topic and keeps its place; a new file adds a topic', () => {
    const builtin = dir({ '1-interview.md': '# Interview\n\nDefault.', '2-mandates.md': '# Mandates\n\nDefault mandates.' });
    const override = dir({ 'mandates.md': '# Mandates\n\nEverything in review.', 'pricing-rules.md': '# Pricing rules\n\nOur discounts.' });
    const g = loadGuides(builtin, override);
    expect(g.map((x) => [x.topic, x.summary, x.source])).toEqual([
      ['interview', 'Default.', 'default'],
      ['mandates', 'Everything in review.', 'override'],
      ['pricing-rules', 'Our discounts.', 'override'],
    ]);
  });

  it('a missing override folder is simply no override', () => {
    expect(loadGuides(dir({ '1-a.md': '# A\n\nx' }), '/nonexistent/guides')).toHaveLength(1);
  });
});

describe('the shipped guides', () => {
  const shipped = loadGuides(builtinGuidesDir(), undefined);
  it('six topics in the agreed order, each with a title and a one-line summary', () => {
    expect(shipped.map((g) => g.topic)).toEqual(['interview', 'package', 'mandates', 'brief', 'agent-process', 'risks']);
    for (const g of shipped) {
      expect(g.title, g.topic).not.toBe('');
      expect(g.summary.length, g.topic).toBeGreaterThan(10);
    }
  });
  it('each is short enough to read in one call (under 3,000 words)', () => {
    for (const g of shipped) expect(g.body.split(/\s+/).length, g.topic).toBeLessThan(3000);
  });
  it('the guides that reveal nothing to the working AI: the brief guide forbids test words', () => {
    expect(shipped.find((g) => g.topic === 'brief')!.body).toMatch(/no "simulation"/);
  });
});

describe('guideHeader', () => {
  it('starts with the language rule and lists each system with its action types and tools', () => {
    const h = guideHeader([{ id: 'erp', profile: 'p/sales@0.3', actionTypes: ['quote', 'send'], writeTools: ['create_quote', 'send_quote'], readTools: ['list_items'] }]);
    expect(h.split('\n')[0]).toMatch(/This guide is in English\. Talk to the person in their language/);
    expect(h).toContain('**erp** — profile `p/sales@0.3`; action types `quote`, `send`; changes via `create_quote`, `send_quote`; reads via `list_items`');
  });
  it('no systems → says so, and what to do', () => {
    expect(guideHeader([])).toMatch(/none yet — ask the person to connect/);
  });
  it('tells the AI where the person approves its proposals', () => {
    process.env.SUVEREN_CP_PORT = '3500';
    try {
      expect(guideHeader([])).toContain('approves it in the Suveren Gateway at http://localhost:3500/approvals');
    } finally { delete process.env.SUVEREN_CP_PORT; }
  });
});

// ── setup__get_guide through the real gate ───────────────────────────────────

function auth(readAccess: string): EnrichedAuthorization {
  const bounds = { read_access: readAccess, brief_daily_max: 0, mandate_daily_max: 0 };
  return {
    authorizationId: 'authz_g0000000-0000-4000-8000-000000000001', profileId: DELEGATION.id, path: 'p',
    frame: bounds, bounds, context: {}, attestations: [], requiredDomains: [], attestedDomains: [],
    deferredCommitmentDomains: ['owner'], signedCommitmentMode: 'review', complete: true, gateContent: null,
  } as unknown as EnrichedAuthorization;
}

function setup(auths: EnrichedAuthorization[]) {
  const postReceipt = vi.fn();
  const state = {
    getEnrichedAuthorizations: () => auths,
    spClient: { postReceipt, submitProposal: vi.fn(), isUnlocked: () => true },
    cache: { invalidate: vi.fn(), getAllAuthorizations: () => auths },
    gatekeeper: { verifyExecution: vi.fn().mockResolvedValue({ result: { approved: true, errors: [] } }) },
    executionLog: { record: vi.fn() },
  } as unknown as SharedState;
  const im = new IntegrationManager();
  registerBuiltins({ state, integrationManager: im });
  // A connector as the guides should see it (registered the same generic way).
  im.registerBuiltin({
    id: 'erp', name: 'ERP', profile: 'github.com/humanagencyprotocol/hap-profiles/sales@0.3', simulation: true,
    toolGating: { overrides: {
      create_quote: { executionMapping: {}, staticExecution: { action_type: 'quote' } },
      list_items: { category: 'read', readGovernance: 'none', readGovernanceReason: 'test' },
    } } as never,
    tools: [
      { name: 'create_quote', description: '', inputSchema: { type: 'object' }, handler: vi.fn() },
      { name: 'list_items', description: '', inputSchema: { type: 'object' }, handler: vi.fn() },
    ],
  });
  const tool = im.getAllTools().find((t) => t.namespacedName === 'setup__get_guide') as DiscoveredTool;
  return { im, call: (args: Record<string, unknown>) => createGatedToolHandler(tool, im, state)(args), postReceipt };
}

describe('setup__get_guide', () => {
  it('lists the topics in order, with the header; reading needs no ticket', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const { call, postReceipt } = setup([auth('unlimited')]);
    const r = await call({});
    expect(r.isError, r.content[0].text).toBeFalsy();
    const text = r.content[0].text;
    expect(text).toMatch(/This guide is in English/);
    expect(text).toMatch(/1\. \*\*interview\*\*.*\n2\. \*\*package\*\*/);
    expect(postReceipt).not.toHaveBeenCalled();
  });

  it('returns a topic with the header first; an override folder replaces it without a restart', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const { call } = setup([auth('unlimited')]);
    expect((await call({ topic: 'mandates' })).content[0].text).toMatch(/# Mandates[\s\S]*Ask first/);
    process.env.SUVEREN_GUIDES_DIR = dir({ 'mandates.md': '# Mandates\n\nAt ACME everything starts in review.' });
    expect((await call({ topic: 'mandates' })).content[0].text).toMatch(/At ACME everything starts in review/);
  });

  it('unknown topic → refused, naming the topics', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const r = await setup([auth('unlimited')]).call({ topic: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Topics: interview, package/);
  });

  it.each([
    ['read_access none', [auth('none')]],
    ['no delegation mandate', []],
  ])('refused with %s', async (_label, auths) => {
    process.env.SUVEREN_SIMULATION = '1';
    const r = await setup(auths as EnrichedAuthorization[]).call({});
    expect(r.isError).toBe(true);
  });

  it('refused outside simulation mode', async () => {
    const r = await setup([auth('unlimited')]).call({});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not available/);
  });

  it('the systems header lists each connector with profile, action types and tools — never a built-in', () => {
    const tool = (integrationId: string, originalName: string, gating: Record<string, unknown> | null) =>
      ({ integrationId, originalName, namespacedName: `${integrationId}__${originalName}`, gating }) as unknown as DiscoveredTool;
    const P = 'github.com/humanagencyprotocol/hap-profiles';
    const im = {
      isBuiltin: (id: string) => id === 'setup',
      getAllTools: () => [
        tool('erp', 'create_quote', { profile: `${P}/sales@0.3`, staticExecution: { action_type: 'quote' } }),
        tool('erp', 'send_quote', { profile: `${P}/sales@0.3`, staticExecution: { action_type: 'send' } }),
        tool('erp', 'list_items', { profile: `${P}/sales@0.3`, category: 'read' }),
        tool('erp', 'legacy', { profile: `${P}/sales@0.3`, category: 'disabled' }),
        tool('crm', 'find_contacts', { profile: `${P}/customers@0.8`, category: 'read' }),
        tool('setup', 'get_guide', { profile: `${P}/delegation@0.1`, category: 'read' }),
      ],
    } as unknown as IntegrationManager;
    expect(connectedSystems(im)).toEqual([
      { id: 'crm', profile: `${P}/customers@0.8`, actionTypes: [], writeTools: [], readTools: ['find_contacts'] },
      { id: 'erp', profile: `${P}/sales@0.3`, actionTypes: ['quote', 'send'], writeTools: ['create_quote', 'send_quote'], readTools: ['list_items'] },
    ]);
  });
});
