import { describe, it, expect } from 'vitest';
import { previewSecret, textFieldsFor, credentialView, META_KEY } from '../lib/credential-meta';

const MANIFESTS = [
  {
    id: 'calendar',
    credentials: {
      fields: [
        { key: 'clientId', type: 'text' },
        { key: 'clientSecret', type: 'password' },
      ],
    },
  },
];

describe('previewSecret', () => {
  it('keeps a public format prefix and the last 4', () => {
    expect(previewSecret('GOCSPX-abcdefghijklmnopa3f9').preview).toBe('GOCSPX-…a3f9');
    expect(previewSecret('github_pat_11ABCDEF0123456789xyz1').preview).toBe('github_pat_…xyz1');
  });

  it('shows last 4 only when there is no recognisable prefix', () => {
    expect(previewSecret('9f81b2c4d6e8a0f2b4d6e8a0').preview).toBe('…e8a0');
  });

  it('reveals NOTHING for short secrets — last-4 of a password is a third of it', () => {
    expect(previewSecret('hunter2!').preview).toBeNull();
    expect(previewSecret('12345678901').preview).toBeNull(); // 11 chars: still below the line
  });

  it('drops the prefix when keeping it would leave too little hidden', () => {
    // 'sk-' + 13 chars: prefix would leave only 13 hidden — below the floor.
    const p = previewSecret('sk-abcdefghi1234');
    expect(p.preview).toBe('…1234');
  });
});

describe('textFieldsFor', () => {
  it('reads the manifest declaration', () => {
    const t = textFieldsFor('calendar', MANIFESTS);
    expect(t.has('clientId')).toBe(true);
    expect(t.has('clientSecret')).toBe(false);
  });

  it('fails closed for an unknown credential name', () => {
    expect(textFieldsFor('mystery', MANIFESTS).size).toBe(0);
  });

  it('fails closed when manifests are unavailable', () => {
    expect(textFieldsFor('calendar', []).size).toBe(0);
    expect(textFieldsFor('calendar', undefined).size).toBe(0);
  });

  it('knows ai-config without a manifest', () => {
    const t = textFieldsFor('ai-config', []);
    expect(t.has('provider')).toBe(true);
    expect(t.has('model')).toBe(true);
    expect(t.has('apiKey')).toBe(false);
  });
});

describe('credentialView', () => {
  const CRED = {
    clientId: '839145520117-fbk2.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-abcdefghijklmnopa3f9',
    // Written by the OAuth flow, declared in NO manifest field list — the case
    // that makes fail-closed load-bearing rather than theoretical.
    refreshToken: '1//0eXyzVeryLongRefreshTokenValue9k2m',
    [META_KEY]: '2026-08-01T09:14:00.000Z',
  };

  it('never contains a secret value, anywhere in the response', () => {
    const v = credentialView(CRED, textFieldsFor('calendar', MANIFESTS));
    const serialized = JSON.stringify(v);
    expect(serialized).not.toContain('GOCSPX-abcdefghijklmnopa3f9');
    expect(serialized).not.toContain('VeryLongRefreshToken');
  });

  it('returns text fields as values and the rest as hints', () => {
    const v = credentialView(CRED, textFieldsFor('calendar', MANIFESTS));
    expect(v.fields.clientId).toContain('googleusercontent');
    expect(v.secrets.clientSecret.preview).toBe('GOCSPX-…a3f9');
    // Undeclared stored key -> secret, by construction.
    expect(v.secrets.refreshToken.preview).toMatch(/…9k2m$/);
  });

  it('surfaces the write timestamp and strips the reserved key from fieldNames', () => {
    const v = credentialView(CRED, textFieldsFor('calendar', MANIFESTS));
    expect(v.updatedAt).toBe('2026-08-01T09:14:00.000Z');
    expect(v.fieldNames).not.toContain(META_KEY);
    expect(v.fieldNames.sort()).toEqual(['clientId', 'clientSecret', 'refreshToken']);
  });
});
