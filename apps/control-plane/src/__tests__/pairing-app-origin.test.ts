/**
 * "Add a phone" says where the phone app is opened. The address is the Authority Server's to give (`appOrigin` of
 * GET /api/as/compat); an older server, an unconfigured one, an unreachable one or a value that is not a bare origin gives none.
 */
import { describe, it, expect } from 'vitest';
import { DevicePairing } from '../lib/device-pairing';

const pairingWith = (call: (m: string, p: string) => Promise<{ status: number; body: unknown }>) =>
  new DevicePairing({ vault: { onLocked: () => {} }, client: { asUrl: 'https://as.example.com', call } } as never);

const answers = (status: number, body: unknown) => pairingWith(async (m, p) => {
  expect([m, p]).toEqual(['GET', '/api/as/compat']);
  return { status, body };
});

describe('DevicePairing.appOrigin', () => {
  it('is the origin the Authority Server names', async () => {
    expect(await answers(200, { appOrigin: 'https://app.example.com' }).appOrigin()).toBe('https://app.example.com');
    expect(await answers(200, { appOrigin: 'http://localhost:4200' }).appOrigin()).toBe('http://localhost:4200');
  });
  it('is nothing for an older server (no field), an error answer or a body that is not JSON', async () => {
    expect(await answers(200, { protocolVersion: '0.7' }).appOrigin()).toBeUndefined();
    expect(await answers(500, { appOrigin: 'https://app.example.com' }).appOrigin()).toBeUndefined();
    expect(await answers(200, null).appOrigin()).toBeUndefined();
  });
  it('is nothing for a value that is not a bare https origin', async () => {
    for (const bad of ['http://app.example.com', 'https://app.example.com/path', 'https://user@app.example.com', 'app.example.com', 42, '']) {
      expect(await answers(200, { appOrigin: bad }).appOrigin()).toBeUndefined();
    }
  });
  it('is nothing when the server cannot be reached', async () => {
    expect(await pairingWith(async () => { throw new Error('down'); }).appOrigin()).toBeUndefined();
  });
});
