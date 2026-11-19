/**
 * What an ADMITTER checks of message 4, `open` (plan 4.3), before the person is asked anything. One implementation for the
 * phone (it admits a computer) and the gateway page (a computer admits a phone).
 *
 * The entry is exactly an `add` of a device of the expected kind that extends the admitter's own verified head, signed by the
 * new device's key; message 2's commitment matches message 4; the label is not taken. The server and every other device verify
 * the same entry again (3.3): the admitter also runs the whole chain check before it appends.
 */
import {
  b64uDecode, b64uEncode, entrySignedBytes, keyIdOf, pairingCommitment, validateDevice, validateEntryShape, verifyEd25519,
  type ChainEntry, type ChainState,
} from '@hap/core/device-keys';
import { labelTaken } from './chain-view';

export type OpenRefusal = 'commit_mismatch' | 'label_taken' | 'open_invalid';

export class OpenCheckError extends Error {
  constructor(readonly code: OpenRefusal) {
    super(code);
    this.name = 'OpenCheckError';
  }
}

export interface OpenExpectation {
  /** The admitter's own verified chain. */
  chain: ChainState;
  rootDid: string;
  /** The admitter's key id: the entry's `signer`. */
  admitterKeyId: string;
  /** The kind of device that is joining: a phone joins a computer's chain, a computer a phone's. */
  kind: 'gateway' | 'approve-app';
  /** The `c` of message 2. */
  commit: string;
}

export interface OpenedEntry {
  /** The entry as the new device built it: no `sigs`. */
  entry: ChainEntry;
  /** The new device's signature over the entry (base64url), as sent. */
  joinerSig: string;
  rJ: Uint8Array;
}

export async function checkOpen(body: Record<string, unknown>, expect: OpenExpectation): Promise<OpenedEntry> {
  let entry: ChainEntry;
  let sigBytes: Uint8Array;
  let rJ: Uint8Array;
  try {
    const raw = body.entry as ChainEntry;
    // The entry arrives without `sigs`; every other member is checked as a chain entry's.
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sigs) || raw.sigs.length !== 0) throw new Error('sigs');
    validateEntryShape({ ...raw, sigs: [{ by: raw.signer, sig: b64uEncode(new Uint8Array(64)) }] });
    entry = raw;
    sigBytes = b64uDecode(body.sig as string);
    rJ = b64uDecode(body.r_j as string);
    if (sigBytes.length !== 64 || rJ.length !== 32) throw new Error('length');
    const dev = validateDevice(entry.device);
    const head = expect.chain.head;
    if (entry.op !== 'add' || entry.root_did !== expect.rootDid || entry.seq !== head.seq + 1 || entry.prev !== head.hash
      || entry.signer !== expect.admitterKeyId || entry.target !== null || entry.check !== null || entry.new_root !== null) throw new Error('entry');
    if (dev.kind !== expect.kind) throw new Error('kind');
    if (dev.key_id !== (await keyIdOf(b64uDecode(dev.sign_pub)))) throw new Error('key id');
    if (!(await verifyEd25519(b64uDecode(dev.sign_pub), entrySignedBytes(entry), sigBytes))) throw new Error('signature');
  } catch {
    throw new OpenCheckError('open_invalid');
  }
  // Message 4 must be the entry message 2 committed to.
  if ((await pairingCommitment(entry, sigBytes, rJ)) !== expect.commit) throw new OpenCheckError('commit_mismatch');
  if (labelTaken(expect.chain, (entry.device as NonNullable<ChainEntry['device']>).label)) throw new OpenCheckError('label_taken');
  return { entry, joinerSig: body.sig as string, rJ };
}
