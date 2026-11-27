import { describe, it, expect, afterEach } from 'vitest';
import { setAsHost } from '@suveren/approval-card/lib/as-host';
import { T, textForCode } from './device-texts';
import { PT, pairingErrorText } from './pairing-texts';

afterEach(() => setAsHost(undefined));

describe('the server named in the gateway page texts', () => {
  it('is suveren.ai until the gateway reports another', () => {
    expect(textForCode('as_unreachable')).toBe('Cannot reach suveren.ai. Check your internet connection and try again.');
  });

  it('is the host of the Authority Server the gateway reports, also after the texts were loaded', () => {
    setAsHost('https://as.example-company.com');
    expect(T.asUnreachable).toBe('Cannot reach as.example-company.com. Check your internet connection and try again.');
    expect(textForCode('as_unreachable')).toContain('as.example-company.com');
    expect(textForCode('recovery_not_done')).not.toContain('suveren.ai');
    expect(pairingErrorText('store_failed')).toContain('as.example-company.com');
    expect(PT.devicesTitle).toBe('Your devices');
  });

  it('an older gateway that reports no address keeps suveren.ai', () => {
    setAsHost('https://as.example-company.com');
    setAsHost(undefined);
    expect(T.asUnreachable).toContain('suveren.ai');
  });

  it('the hosted server is suveren.ai however it is written: nothing is rewritten', () => {
    for (const url of ['https://suveren.ai', 'https://www.suveren.ai', 'https://www.suveren.ai/']) {
      setAsHost(url);
      expect(textForCode('as_unreachable')).toBe('Cannot reach suveren.ai. Check your internet connection and try again.');
      expect(T.asUnreachable).toBe('Cannot reach suveren.ai. Check your internet connection and try again.');
      expect(textForCode('recovery_not_done')).toBe('suveren.ai does not have the new entry yet. Finish in the browser, then try again.');
    }
  });

  it('a host that contains suveren.ai is rewritten once, correctly', () => {
    setAsHost('https://staging.suveren.ai');
    expect(T.asUnreachable).toBe('Cannot reach staging.suveren.ai. Check your internet connection and try again.');
    expect(textForCode('as_unreachable')).toBe('Cannot reach staging.suveren.ai. Check your internet connection and try again.');
    expect(pairingErrorText('store_failed')).toContain('staging.suveren.ai has added');
    expect(pairingErrorText('store_failed')).not.toContain('staging.staging');
    setAsHost('https://as.example-company.com');
    expect(textForCode('as_unreachable')).toBe('Cannot reach as.example-company.com. Check your internet connection and try again.');
  });

  it('an argument passed into a text keeps its own suveren.ai (an email)', () => {
    setAsHost('https://as.example-company.com');
    expect(T.connectedAs('Ann', 'ann@suveren.ai')).toBe('Connected as Ann (ann@suveren.ai). You are signed in.');
  });
});
