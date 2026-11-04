/**
 * The UI's own copy of the protocol versions this gateway speaks must equal
 * hap-core's `SUPPORTED_VERSIONS` — the browser bundle cannot import hap-core
 * at runtime (node crypto), so the list is duplicated here and pinned by this
 * test. A drift would make the UI ask the Authority Server for a version the
 * gateway's Gatekeeper cannot verify, or stop asking for one it can.
 */
import { describe, it, expect } from 'vitest';
import { SUPPORTED_VERSIONS, PROTOCOL_VERSION } from '@hap/core';
import { SUPPORTED_PROTOCOL_VERSIONS } from './sp-client';

describe('SUPPORTED_PROTOCOL_VERSIONS (UI) mirrors hap-core', () => {
  it('lists exactly hap-core\'s SUPPORTED_VERSIONS, in the same order (newest first)', () => {
    expect([...SUPPORTED_PROTOCOL_VERSIONS]).toEqual([...SUPPORTED_VERSIONS]);
  });

  it('names the version this package issues first', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS[0]).toBe(PROTOCOL_VERSION);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('0.8');
  });
});
