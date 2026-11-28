/**
 * "Add a phone" says where the phone app is opened. The gateway holds that address; the Authority Server never gives it, so a
 * hacked or hostile server cannot send people to a fake app. SUVEREN_APP_ORIGIN (set by IT) wins; otherwise app.suveren.ai for a
 * gateway on suveren.ai; otherwise none.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { DevicePairing } from '../lib/device-pairing';

const calls: string[] = [];
const on = (asUrl: string) => new DevicePairing({
  vault: { onLocked: () => {} },
  client: { asUrl, call: async (m: string, p: string) => { calls.push(`${m} ${p}`); return { status: 200, body: { appOrigin: 'https://evil.example' } }; } },
} as never);

const prev = process.env.SUVEREN_APP_ORIGIN;
afterEach(() => { if (prev === undefined) delete process.env.SUVEREN_APP_ORIGIN; else process.env.SUVEREN_APP_ORIGIN = prev; });

describe('DevicePairing.appOrigin', () => {
  it('is app.suveren.ai for a gateway on suveren.ai, with or without www', async () => {
    delete process.env.SUVEREN_APP_ORIGIN;
    expect(await on('https://suveren.ai').appOrigin()).toBe('https://app.suveren.ai');
    expect(await on('https://www.suveren.ai').appOrigin()).toBe('https://app.suveren.ai');
  });
  it('is none for another Authority Server when IT set nothing', async () => {
    delete process.env.SUVEREN_APP_ORIGIN;
    expect(await on('https://as.example.com').appOrigin()).toBeUndefined();
    expect(await on('http://localhost:4100').appOrigin()).toBeUndefined();
  });
  it('is what IT set in SUVEREN_APP_ORIGIN, whatever the Authority Server', async () => {
    process.env.SUVEREN_APP_ORIGIN = 'https://app.example-company.com';
    expect(await on('https://suveren.ai').appOrigin()).toBe('https://app.example-company.com');
    process.env.SUVEREN_APP_ORIGIN = 'http://localhost:4200';
    expect(await on('http://localhost:4100').appOrigin()).toBe('http://localhost:4200');
  });
  it('is none for a set value that is not a bare https origin — never a guess', async () => {
    for (const bad of ['http://app.example.com', 'https://app.example.com/path', 'https://user@app.example.com', 'app.example.com']) {
      process.env.SUVEREN_APP_ORIGIN = bad;
      expect(await on('https://suveren.ai').appOrigin()).toBeUndefined();
    }
  });
  it('never asks the Authority Server', async () => {
    calls.length = 0;
    delete process.env.SUVEREN_APP_ORIGIN;
    await on('https://suveren.ai').appOrigin();
    process.env.SUVEREN_APP_ORIGIN = 'https://app.example-company.com';
    await on('https://as.example.com').appOrigin();
    expect(calls).toEqual([]);
  });
});
