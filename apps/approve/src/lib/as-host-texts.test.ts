import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('the server named in the phone app texts', () => {
  it('is suveren.ai by default (production)', async () => {
    const { errorText, P } = await import('../texts');
    expect(errorText('as_unreachable')).toBe('Cannot reach suveren.ai. Check your internet connection and try again.');
    expect(P.setupChecking).toContain('suveren.ai');
  });

  it('is the host of the Authority Server this build was made for', async () => {
    vi.stubEnv('VITE_AS_URL', 'https://as.example-company.com');
    await import('./config'); // the app's start: it learns its server here
    const { errorText, blockedText, P, BLOCKED_REASONS } = await import('../texts');
    expect(errorText('as_unreachable')).toBe('Cannot reach as.example-company.com. Check your internet connection and try again.');
    expect(P.setupChecking).toBe('Checking as.example-company.com...');
    expect(P.giveRefusedAs).toContain('as.example-company.com');
    for (const r of BLOCKED_REASONS) expect(blockedText(r)).not.toContain('suveren.ai');
    expect(errorText('mailbox_refused')).not.toContain('suveren.ai'); // a shared sentence, from the approval-card package
  });

  it('www.suveren.ai is the hosted server: nothing is rewritten', async () => {
    vi.stubEnv('VITE_AS_URL', 'https://www.suveren.ai');
    await import('./config');
    const { errorText } = await import('../texts');
    expect(errorText('as_unreachable')).toBe('Cannot reach suveren.ai. Check your internet connection and try again.');
  });

  it('keeps the port of a local Authority Server', async () => {
    vi.stubEnv('VITE_AS_URL', 'http://localhost:4100');
    await import('./config');
    const { errorText } = await import('../texts');
    expect(errorText('as_unreachable')).toContain('localhost:4100');
  });
});
