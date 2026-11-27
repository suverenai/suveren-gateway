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
});
