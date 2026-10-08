import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildMandateBrief } from '../src/lib/mandate-brief';
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
      expect(brief).toMatch(/Use only the Suveren tools/);
    }
    delete process.env.SUVEREN_SIMULATION;
  });

  it('includes Suveren preamble', () => {
    const brief = buildMandateBrief({ authorizations: [] });
    expect(brief).toContain('Human Agency Protocol');
    expect(brief).toContain('bounded authorities');
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
    // The setup built-in is what makes a delegation mandate visible in simulation mode (agent-visibility.ts).
    const im = { getAllTools: () => [{ gating: { profile: 'github.com/humanagencyprotocol/hap-profiles/delegation@0.1' } }] } as never;
    afterEach(() => { delete process.env.SUVEREN_SIMULATION; delete process.env.SUVEREN_CP_PORT; });

    it('with a Delegation mandate: points the AI at the setup guide', () => {
      process.env.SUVEREN_SIMULATION = '1';
      const brief = buildMandateBrief({ authorizations: [delegation()], integrationManager: im });
      expect(brief).toContain('=== GETTING STARTED ===');
      expect(brief).toContain('call setup__get_guide first and follow its steps in order');
    });

    it('without one: names the one step a person takes, at the gateway\'s own address', () => {
      process.env.SUVEREN_SIMULATION = '1';
      process.env.SUVEREN_CP_PORT = '3500';
      const brief = buildMandateBrief({ authorizations: [], integrationManager: im });
      expect(brief).toContain('create a "Delegation" mandate in the Suveren Gateway at http://localhost:3500');
      expect(brief).not.toContain('setup__get_guide first');
    });

    it('never says "simulation" or "test" — the working AI reads these lines too', () => {
      process.env.SUVEREN_SIMULATION = '1';
      for (const auths of [[delegation()], []]) {
        const brief = buildMandateBrief({ authorizations: auths, integrationManager: im });
        const section = brief.slice(brief.indexOf('=== GETTING STARTED ==='));
        expect(section).not.toMatch(/simulat|\btest/i);
      }
    });

    it('outside simulation mode: no such section', () => {
      expect(buildMandateBrief({ authorizations: [delegation()] })).not.toContain('GETTING STARTED');
    });
  });
});
