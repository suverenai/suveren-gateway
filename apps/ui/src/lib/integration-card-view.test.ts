import { describe, it, expect } from 'vitest';
import { statusWord, authWord, startsOpen, readsPhrase, connectorOneLine, type OneLineInput } from './integration-card-view';
import { readAgeLabel } from '../components/IntegrationCard';

const base: OneLineInput = {
  cardState: 'running', authFailed: false, requiredLabels: [], oauth: false, noFields: false,
  reads: null, stopped: 'stopped',
};

describe('statusWord', () => {
  it('running is bold, never a coloured pill', () => {
    expect(statusWord('running', { t: 'Stopped' })).toEqual({ text: 'Running', tone: 'bold' });
  });
  it('not set up covers both setup steps and is muted', () => {
    expect(statusWord('unconfigured', { t: 'Stopped' })).toEqual({ text: 'Not set up', tone: 'muted' });
    expect(statusWord('needs-oauth', { t: 'Stopped' })).toEqual({ text: 'Not set up', tone: 'muted' });
  });
  it('a registered-but-down connector takes the stopped word; only a crash is bold', () => {
    expect(statusWord('ready', { t: 'Paused' })).toEqual({ text: 'Paused', tone: 'muted' });
    expect(statusWord('ready', { t: 'Stopped' })).toEqual({ text: 'Stopped', tone: 'muted' });
    expect(statusWord('ready', { t: 'Crashed' })).toEqual({ text: 'Crashed', tone: 'bold' });
  });
});

describe('authWord', () => {
  it('no auth needed is a quiet note', () => {
    expect(authWord({ needsAuth: false, authFailed: false, authConnected: false })).toEqual({ text: 'No auth', tone: 'muted' });
  });
  it('failed is bold, connected is quiet, not connected says nothing (the status word already does)', () => {
    expect(authWord({ needsAuth: true, authFailed: true, authConnected: true })).toEqual({ text: 'Auth failed', tone: 'bold' });
    expect(authWord({ needsAuth: true, authFailed: false, authConnected: true })).toEqual({ text: 'Auth OK', tone: 'muted' });
    expect(authWord({ needsAuth: true, authFailed: false, authConnected: false })).toBeNull();
  });
});

describe('startsOpen', () => {
  it('a healthy running or starting connector starts closed', () => {
    expect(startsOpen('running', false)).toBe(false);
    expect(startsOpen('starting', false)).toBe(false);
  });
  it('anything that needs something starts open — nothing the tests click is hidden', () => {
    for (const s of ['needs-oauth', 'ready'] as const) expect(startsOpen(s, false)).toBe(true);
    // Not set up = optional, nothing started: closed, so the page stays short.
    expect(startsOpen('unconfigured', false)).toBe(false);
    // …unless it can be started right away (every field optional → Activate).
    expect(startsOpen('unconfigured', false, true)).toBe(true);
    expect(startsOpen('running', true)).toBe(true);
  });
});

describe('readsPhrase', () => {
  it('is null until the window is loaded; 0 is a real choice', () => {
    expect(readsPhrase(undefined, readAgeLabel)).toBeNull();
    expect(readsPhrase(null, readAgeLabel)).toBe('reads follow your mandate');
    expect(readsPhrase(0, readAgeLabel)).toBe('reads nothing');
    expect(readsPhrase(30, readAgeLabel)).toBe('reads 30 days back');
  });
});

describe('connectorOneLine', () => {
  it('running: the mode note and the read window, joined', () => {
    expect(connectorOneLine({ ...base, modeNote: 'Simulated mailbox', reads: 'reads 30 days back' })).toBe('Simulated mailbox · reads 30 days back');
    expect(connectorOneLine({ ...base, modeNote: 'On this computer. VAT-ID checks ask the EU VIES service.' })).toBe('On this computer. VAT-ID checks ask the EU VIES service');
  });
  it('running with nothing to say: nothing to set up, or credentials on file', () => {
    expect(connectorOneLine({ ...base, noFields: true })).toBe('Nothing to set up');
    expect(connectorOneLine(base)).toBe('Credentials on file');
  });
  it('never uses the word "running" — the status word is the one place that says it', () => {
    for (const cardState of ['running', 'starting', 'unconfigured', 'needs-oauth', 'ready'] as const) {
      for (const stopped of ['paused', 'crashed', 'stopped'] as const) {
        expect(connectorOneLine({ ...base, cardState, stopped, authFailed: false }).toLowerCase()).not.toContain('running');
      }
    }
    expect(connectorOneLine({ ...base, authFailed: true }).toLowerCase()).not.toContain('running');
  });
  it('not set up: names what it needs, and the account step for OAuth', () => {
    expect(connectorOneLine({ ...base, cardState: 'unconfigured', requiredLabels: ['Client ID', 'Client Secret'], oauth: true }))
      .toBe('Needs Client ID and Client Secret, then connect your account');
    expect(connectorOneLine({ ...base, cardState: 'unconfigured', requiredLabels: ['Access Token'] })).toBe('Needs Access Token');
    expect(connectorOneLine({ ...base, cardState: 'unconfigured', requiredLabels: ['A', 'B', 'C'] })).toBe('Needs A, B and C');
  });
  it('not set up with only optional fields: the manifest hint', () => {
    expect(connectorOneLine({ ...base, cardState: 'unconfigured', setupHint: 'No configuration needed — works out of the box.' }))
      .toBe('No configuration needed — works out of the box.');
  });
  it('waiting for the account, stopped, paused, crashed, failed auth', () => {
    expect(connectorOneLine({ ...base, cardState: 'needs-oauth' })).toBe('Credentials saved — connect your account');
    expect(connectorOneLine({ ...base, cardState: 'ready', stopped: 'paused' })).toBe('Paused while simulation mode is on');
    expect(connectorOneLine({ ...base, cardState: 'ready', stopped: 'crashed' })).toBe('Stopped with an error');
    expect(connectorOneLine({ ...base, cardState: 'ready', stopped: 'stopped' })).toBe('Credentials saved — start it to use it');
    expect(connectorOneLine({ ...base, authFailed: true })).toBe('The stored credentials stopped working — reconnect to use it again');
  });
});
