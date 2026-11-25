import { identityCode } from '@hap/core/device-keys';

/** The account's identity code, 24 digits in 6 groups of 4 (plan 4.4). Derived from the root DID; a person compares it with the one another device shows. */
export function identityCodeOf(rootDid: string): Promise<string> {
  return identityCode(rootDid);
}
