/**
 * The MCP server's side of a vault-key change (the control plane moving the
 * vault to an unlock password). Pulled out of bin/http.ts, which starts a server
 * on import, so the real handlers can be tested.
 *
 *  - `setKey`: what /internal/configure does with a key. Remembers which key the
 *    stores now hold, as a fingerprint.
 *  - `state`: which of two candidate keys the sealed files in this folder are
 *    sealed with, and the fingerprint of the key in memory. Never the key.
 *  - `rekey`: re-seal this folder's files from the old key to the new one and
 *    switch the stores, in one synchronous step. Idempotent and resumable: a run
 *    that stopped halfway (or whose reply was lost) is completed by running it
 *    again, and a run on a folder already on the new key changes nothing.
 *
 * The control plane decides which key to configure from `state`, never from its
 * own record of what it asked for.
 */

import { createHash } from 'node:crypto';
import { rekeyDirectory, sealedWith, CONTROL_PLANE_FILES, type SealedWith } from './rekey';

export interface KeyedStore { setVaultKey(key: Buffer): void }

export const keyFingerprint = (key: Buffer): string => createHash('sha256').update(key).digest('hex').slice(0, 16);

const isKey = (h: unknown): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h);

export interface HandlerResult { status: number; body: Record<string, unknown> }

export class VaultKeyControl {
  private fingerprint: string | null = null;

  constructor(private readonly dataDir: string, private readonly stores: readonly KeyedStore[]) {}

  setKey(key: Buffer): void {
    for (const s of this.stores) s.setVaultKey(key);
    this.fingerprint = keyFingerprint(key);
  }

  state(body: { oldKeyHex?: unknown; newKeyHex?: unknown }): HandlerResult {
    if (!isKey(body.oldKeyHex) || !isKey(body.newKeyHex)) return { status: 400, body: { error: 'Missing or malformed keys' } };
    const oldKey = Buffer.from(body.oldKeyHex, 'hex');
    const newKey = Buffer.from(body.newKeyHex, 'hex');
    const sealed: SealedWith = sealedWith(this.dataDir, oldKey, newKey, { skip: CONTROL_PLANE_FILES });
    const inMemory = this.fingerprint === null ? 'none' : this.fingerprint === keyFingerprint(oldKey) ? 'old' : this.fingerprint === keyFingerprint(newKey) ? 'new' : 'other';
    oldKey.fill(0); newKey.fill(0);
    return { status: 200, body: { sealedWith: sealed, inMemory, fingerprint: this.fingerprint } };
  }

  rekey(body: { oldKeyHex?: unknown; newKeyHex?: unknown }): HandlerResult {
    if (!isKey(body.oldKeyHex) || !isKey(body.newKeyHex)) return { status: 400, body: { error: 'Missing or malformed keys' } };
    const oldKey = Buffer.from(body.oldKeyHex, 'hex');
    const key = Buffer.from(body.newKeyHex, 'hex');
    const result = rekeyDirectory(this.dataDir, oldKey, key, { skip: CONTROL_PLANE_FILES });
    this.setKey(key);
    oldKey.fill(0);
    return { status: 200, body: { ok: true, reSealed: result.reSealed, alreadyNew: result.alreadyNew, unreadable: result.unreadable } };
  }
}
