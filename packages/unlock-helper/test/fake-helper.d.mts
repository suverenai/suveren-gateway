export function newKey(): { blob: string; pub: Buffer };
export function wrapKey(wrapPub: Buffer, vaultKey: Buffer, aad: string): Buffer;
export function unwrapKey(blob: string, wrapped: Buffer, aad: string): Buffer;
export function signDigest(blob: string, digest: Buffer): { signature: Buffer; pub: Buffer };
