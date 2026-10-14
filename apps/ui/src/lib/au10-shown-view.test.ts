import { describe, it, expect } from 'vitest';
import { shownStatus, formatReadAt } from './au10-shown-view';

describe('shownStatus', () => {
  it('off-device wins regardless of the hashes', () => {
    expect(shownStatus({ offDevice: true, recordedHash: 'sha256:a', localHash: 'sha256:a' })).toBe('off-device');
    expect(shownStatus({ offDevice: true, recordedHash: undefined, localHash: undefined })).toBe('off-device');
  });

  it('unchecked when the Authority Server records no shownHash at all', () => {
    expect(shownStatus({ offDevice: false, recordedHash: undefined, localHash: 'sha256:a' })).toBe('unchecked');
  });

  it('verified when the local hash matches the recorded one', () => {
    expect(shownStatus({ offDevice: false, recordedHash: 'sha256:a', localHash: 'sha256:a' })).toBe('verified');
  });

  it('mismatch when the local hash differs from the recorded one', () => {
    expect(shownStatus({ offDevice: false, recordedHash: 'sha256:a', localHash: 'sha256:b' })).toBe('mismatch');
  });

  it('mismatch (never "verified") when the local hash is missing but one was recorded', () => {
    expect(shownStatus({ offDevice: false, recordedHash: 'sha256:a', localHash: undefined })).toBe('mismatch');
  });
});

describe('formatReadAt', () => {
  it('renders an HH:MM-shaped string', () => {
    expect(formatReadAt(Date.now())).toMatch(/\d{1,2}:\d{2}/);
  });
});
