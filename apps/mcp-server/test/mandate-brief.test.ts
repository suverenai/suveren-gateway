import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMandateBrief } from '../src/lib/mandate-brief';
import { FIRST_LINE, REPLY_RULE } from '../src/lib/guidance';
import type { EnrichedAuthorization } from '../src/lib/shared-state';
import type { ExecutionLog } from '../src/lib/execution-log';

function mockAuth(overrides: Partial<EnrichedAuthorization> = {}): EnrichedAuthorization {
  const now = Math.floor(Date.now() / 1000);
  return {
    frameHash: 'sha256:abc',
    profileId: 'charge@0.3',
    path: 'charge-routine',
    frame: {
      profile: 'charge@0.3',
      path: 'charge-routine',
      amount_max: 100,
      currency: 'USD',
      action_type: 'charge',
      amount_daily_max: 500,
      amount_monthly_max: 5000,
      transaction_count_daily_max: 20,
    },
    attestations: [{ domain: 'finance', blob: 'blob', expiresAt: now + 2700 }],
    requiredDomains: ['finance'],
    attestedDomains: ['finance'],
    complete: true,
    gateContent: {
      intent: 'Enable automated purchasing. Allow agent to process payments. Accepts risk of charges up to limits.',
    },
    ...overrides,
  };
}

function mockLog(): ExecutionLog {
  return {
    sumByWindow: vi.fn().mockReturnValue(0),
    record: vi.fn(),
  } as unknown as ExecutionLog;
}

describe('buildMandateBrief', () => {
  it('always carries the rules — never the gateway page, the key or an approval; only the Suveren tools', () => {
    for (const sim of [undefined, '1']) {
      if (sim) process.env.SUVEREN_SIMULATION = sim; else delete process.env.SUVEREN_SIMULATION;
      const brief = buildMandateBrief({ authorizations: [] });
      expect(brief).toContain('=== RULES ===');
      expect(brief).toMatch(/Never open or operate the Suveren Gateway's web page/);
      expect(brief).toMatch(/never write as if you were that person or any person/);
      expect(brief.indexOf('never write as if you were that person')).toBeLessThan(brief.indexOf('Never open or operate'));
      expect(brief).toMatch(/Use only the Suveren tools/);
    }
    delete process.env.SUVEREN_SIMULATION;
  });

  // Real ChatGPT added its own "Sent by Andreas's AI assistant." line: the gateway's footer is the only mark.
  it('the golden rule ends: the gateway adds the AI mark, the AI adds no sign-off of its own', async () => {
    const { NO_IMPERSONATION_RULE, AGENT_RULES } = await import('../src/lib/agent-rules');
    expect(AGENT_RULES[0]).toBe(NO_IMPERSONATION_RULE);
    expect(NO_IMPERSONATION_RULE.endsWith(
      'Every message you send is marked as sent by an AI agent; make that true of every word. The gateway adds that mark; do not add a sign-off or footer of your own.',
    )).toBe(true);
    expect(buildMandateBrief({ authorizations: [] })).toContain('do not add a sign-off or footer of your own');
  });

  it('includes Suveren preamble', () => {
    const brief = buildMandateBrief({ authorizations: [] });
    expect(brief).toContain('Suveren lets this person have you, their AI, do their work within limits they set');
    expect(brief).toContain('If a call is refused, tell the person what it says; do not retry it');
  });

  // Codex lists the server as a tool namespace described by the first line only, and loads the tools
  // later: in the 2026-11-11 release check it answered "hi" as a general assistant. That line alone
  // must say what Suveren is for and the one call to make. The same in every state and mode.
  it('the first line alone says what Suveren is for and the call to make first, the same in every state', () => {
    const empty = buildMandateBrief({ authorizations: [] });
    const held = buildMandateBrief({ authorizations: [mockAuth()] });
    process.env.SUVEREN_SIMULATION = '1';
    const test = buildMandateBrief({ authorizations: [] });
    delete process.env.SUVEREN_SIMULATION;
    for (const b of [empty, held, test]) expect(b.split('\n')[0]).toBe(FIRST_LINE);
    expect(FIRST_LINE).toContain('before your first reply in a chat, call list-authorizations()');
    expect(FIRST_LINE).not.toMatch(/\bMUST\b|simulat|\btest/i);
    expect(FIRST_LINE.length).toBeLessThan(200);
  });

  // Claude Code keeps only the first 4096 characters of a server's instructions ("… [truncated]").
  // Before 2026-11-11 the reply rule sat at character ~4130 of an empty gateway's instructions, and an
  // agent brief went before the rules, so a long brief pushed the golden rule out of what Claude read.
  const CLAUDE_CODE_KEEPS = 4096;
  it('what Claude Code keeps holds the reply rule and the rules, even with a long agent brief', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brief-cut-'));
    writeFileSync(join(dir, 'context.md'), '# Agent brief\n\n' + 'Answer quote requests the same day. '.repeat(100));
    for (const auths of [[], [mockAuth()]]) {
      const kept = buildMandateBrief({ authorizations: auths, contextDir: dir }).slice(0, CLAUDE_CODE_KEEPS);
      expect(kept).toContain(REPLY_RULE);
      expect(kept).toContain('never write as if you were that person or any person');
      expect(kept).toContain('Never approve a proposal: approvals are the person\'s alone.');
    }
  });

  // V7
  it('leads with the Authority Server incompatibility when asVersionRefusal is set', () => {
    const brief = buildMandateBrief({
      authorizations: [mockAuth()],
      asVersionRefusal: 'This Authority Server supports protocol version(s) [0.6], not 0.7.',
    });
    expect(brief).toContain('AUTHORITY SERVER INCOMPATIBLE');
    expect(brief).toContain('supports protocol version(s) [0.6], not 0.7');
    // It precedes the active-authorities section — the agent should not
    // have to read past a list of grants it cannot act on to find out why.
    expect(brief.indexOf('AUTHORITY SERVER INCOMPATIBLE')).toBeLessThan(brief.indexOf('ACTIVE AUTHORITIES'));
  });

  it('omits the incompatibility section when asVersionRefusal is absent', () => {
    const brief = buildMandateBrief({ authorizations: [] });
    expect(brief).not.toContain('AUTHORITY SERVER INCOMPATIBLE');
  });

  it('includes active authority as a compact one-line summary', () => {
    const brief = buildMandateBrief({ authorizations: [mockAuth()] });
    expect(brief).toContain('=== ACTIVE AUTHORITIES ===');
    // New shape: [shortName@version] bound:val · ... · N min remaining
    expect(brief).toContain('[charge@0.3]');
    expect(brief).toContain('amount_max:100');
    expect(brief).toContain('min remaining');
    // Pointer to on-demand details
    expect(brief).toContain('list-authorizations(domain: "charge")');
  });

  it('does NOT inline the Intent paragraph — intent is pull-on-demand', () => {
    // Regression guard for the Phase 1 trim: intents stay out of the session
    // brief to keep prelude token cost constant as authorizations grow.
    const brief = buildMandateBrief({ authorizations: [mockAuth()] });
    expect(brief).not.toContain('Enable automated purchasing');
    expect(brief).not.toMatch(/Intent:\s/);
  });

  it('includes pending authorities with missing domains', () => {
    const pending = mockAuth({
      complete: false,
      path: 'charge-reviewed',
      requiredDomains: ['finance', 'compliance'],
      attestedDomains: ['finance'],
    });
    const brief = buildMandateBrief({ authorizations: [pending] });
    expect(brief).toContain('PENDING');
    expect(brief).toContain('compliance');
  });

  it('includes list-authorizations instruction', () => {
    const brief = buildMandateBrief({ authorizations: [mockAuth()] });
    expect(brief).toContain('list-authorizations');
  });

  it('includes context section when contextDir has context.md', () => {
    // We can't easily test this without a real file, so just verify
    // the function doesn't crash when contextDir is provided
    const brief = buildMandateBrief({
      authorizations: [mockAuth()],
      contextDir: '/nonexistent',
    });
    expect(brief).toContain('=== ACTIVE AUTHORITIES ===');
    // No context section since file doesn't exist
    expect(brief).not.toContain('=== CONTEXT ===');
  });

  describe('getting started (simulation mode only)', () => {
    const delegation = () => mockAuth({
      profileId: 'github.com/humanagencyprotocol/hap-profiles/delegation@0.1',
      path: 'delegation',
      frame: { profile: 'github.com/humanagencyprotocol/hap-profiles/delegation@0.1', read_access: 'unlimited', brief_daily_max: 5, mandate_daily_max: 30 },
    });
    // The setup built-in is what makes a delegation mandate visible in simulation mode (agent-visibility.ts),
    // and the one whose tool carries the `mandate` action type is the Setup mandate (guidance-runtime.ts).
    const builtinFor = (profile: string) => ({
      getAllTools: () => [{
        integrationId: 'setup', namespacedName: 'setup__create_mandate',
        gating: { profile, executionMapping: {}, staticExecution: { action_type: 'mandate' } },
      }],
      isBuiltin: (id: string) => id === 'setup',
      getBuiltins: () => [{ id: 'setup', name: 'Setup' }],
    }) as never;
    const im = builtinFor('github.com/humanagencyprotocol/hap-profiles/delegation@0.1');
    afterEach(() => { delete process.env.SUVEREN_SIMULATION; delete process.env.SUVEREN_CP_PORT; });

    it('with a Setup mandate: points the AI at the setup guide', () => {
      process.env.SUVEREN_SIMULATION = '1';
      const brief = buildMandateBrief({ authorizations: [delegation()], integrationManager: im });
      expect(brief).toContain('=== GETTING STARTED ===');
      expect(brief).toContain('call setup__get_guide first and follow its steps in order');
    });

    // Found by what it carries, not by a name in the code: the same holds for an area called anything.
    it('with a Setup mandate on an area of another name: still points the AI at the setup guide', () => {
      process.env.SUVEREN_SIMULATION = '1';
      const vollmacht = mockAuth({
        profileId: 'github.com/x/hap-profiles/vollmacht@1.0', path: 'vollmacht',
        frame: { profile: 'github.com/x/hap-profiles/vollmacht@1.0' },
      });
      const brief = buildMandateBrief({ authorizations: [vollmacht], integrationManager: builtinFor('github.com/x/hap-profiles/vollmacht@1.0') });
      expect(brief).toContain('call setup__get_guide first and follow its steps in order');
      // A mandate of another area is not the Setup mandate.
      const other = buildMandateBrief({ authorizations: [mockAuth()], integrationManager: builtinFor('github.com/x/hap-profiles/vollmacht@1.0') });
      expect(other).not.toContain('call setup__get_guide first');
    });

    it('without one: names the one step a person takes, at the gateway\'s own address', () => {
      process.env.SUVEREN_SIMULATION = '1';
      process.env.SUVEREN_CP_PORT = '3500';
      const brief = buildMandateBrief({ authorizations: [], integrationManager: im });
      expect(brief).toContain('=== FIRST STEP ===');
      expect(brief).toContain('They open the Suveren Gateway page themselves, in their own browser, outside this chat, then **Mandates → + New mandate**');
      expect(brief).not.toMatch(/https?:\/\/localhost/);
      expect(brief).toContain('card **Setup**');
      expect(brief).not.toContain('setup__get_guide first');
    });

    it('never says "simulation" or "test" — the working AI reads these lines too', () => {
      process.env.SUVEREN_SIMULATION = '1';
      for (const auths of [[delegation()], []]) {
        const brief = buildMandateBrief({ authorizations: auths, integrationManager: im });
        const at = brief.indexOf('=== GETTING STARTED ===');
        expect((at < 0 ? brief : brief.slice(at))).not.toMatch(/simulat|\btest/i);
      }
    });

    it('outside simulation mode: no such section', () => {
      expect(buildMandateBrief({ authorizations: [delegation()] })).not.toContain('GETTING STARTED');
    });
  });
});
