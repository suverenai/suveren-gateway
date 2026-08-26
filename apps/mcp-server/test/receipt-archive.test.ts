/**
 * Receipt Archive Tests
 *
 * The archive is the subject's own durable copy of the evidence: complete
 * signed receipts + attestation blobs + AS pubkey. Verifies:
 *  - receipts persist verbatim and survive a restart (no pruning)
 *  - dedup by receipt id (idempotent retries never duplicate evidence)
 *  - attestation blobs dedup per authorization and merge across calls
 *  - encryption migration mirrors the GateStore pattern
 *  - a corrupt file is preserved aside, never overwritten
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ReceiptArchive, type ReceiptArchiveEntry } from '../src/lib/receipt-archive';

function makeVaultKey(): Buffer {
  return randomBytes(32);
}

function makeEntry(overrides: Partial<ReceiptArchiveEntry> = {}): ReceiptArchiveEntry {
  return {
    receipt: {
      id: 'rcpt-1',
      boundsHash: 'sha256:bounds123',
      profileId: 'charge@0.5',
      action: 'mollie_create_payment_link',
      actionType: 'charge',
      executionContext: { amount: 5, currency: 'EUR' },
      timestamp: 1735888050,
      signature: 'c2lnbmF0dXJl',
    },
    authorizationId: 'authz-abc',
    asUrl: 'https://as.example',
    asPublicKey: 'aabbcc',
    authorization: {
      profileId: 'charge@0.5',
      boundsHash: 'sha256:bounds123',
      bounds: { amount_max: 100, currency: 'EUR' },
      context: { action_type: 'charge' },
      intent: 'Charge returning customers for confirmed orders only.',
      attestations: [{ domain: 'payments', blob: 'blob-1', expiresAt: 2000000000 }],
    },
    ...overrides,
  };
}

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'suveren-receipt-archive-test-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('ReceiptArchive', () => {
  it('persists the complete signed receipt verbatim and survives restart', () => {
    const archive = new ReceiptArchive(testDir);
    const entry = makeEntry();
    archive.record(entry, 1735888060);

    const reopened = new ReceiptArchive(testDir);
    expect(reopened.size).toBe(1);
    const stored = reopened.getReceipts()[0];
    expect(stored.receipt).toEqual(entry.receipt);
    expect(stored.asUrl).toBe('https://as.example');
    expect(stored.asPublicKey).toBe('aabbcc');
    expect(stored.archivedAt).toBe(1735888060);

    const auths = reopened.getAuthorizations();
    expect(auths).toHaveLength(1);
    expect(auths[0].attestations).toEqual([
      { domain: 'payments', blob: 'blob-1', expiresAt: 2000000000 },
    ]);
    // Plaintext values ride next to the hashes — evidence must be readable,
    // not only verifiable.
    expect(auths[0].bounds).toEqual({ amount_max: 100, currency: 'EUR' });
    expect(auths[0].context).toEqual({ action_type: 'charge' });
    expect(auths[0].intent).toBe('Charge returning customers for confirmed orders only.');
  });

  it('back-fills bounds/context on an entry archived before they were known', () => {
    const archive = new ReceiptArchive(testDir);
    const bare = makeEntry();
    archive.record({
      ...bare,
      authorization: { profileId: 'charge@0.5', attestations: [] }, // evicted cache: no values
    });
    expect(archive.getAuthorizations()[0].bounds).toBeUndefined();

    archive.record(makeEntry({ receipt: { ...bare.receipt, id: 'rcpt-2' } }));
    const auth = archive.getAuthorizations()[0];
    expect(auth.bounds).toEqual({ amount_max: 100, currency: 'EUR' });
    expect(auth.context).toEqual({ action_type: 'charge' });
    expect(auth.intent).toBe('Charge returning customers for confirmed orders only.');
  });

  it('dedups receipts by id — a replayed receipt is archived once', () => {
    const archive = new ReceiptArchive(testDir);
    archive.record(makeEntry());
    archive.record(makeEntry()); // idempotent retry returns the same receipt
    expect(archive.size).toBe(1);

    archive.record(makeEntry({ receipt: { ...makeEntry().receipt, id: 'rcpt-2' } }));
    expect(archive.size).toBe(2);
  });

  it('merges new attestation blobs into an existing authorization', () => {
    const archive = new ReceiptArchive(testDir);
    archive.record(makeEntry());
    archive.record(
      makeEntry({
        receipt: { ...makeEntry().receipt, id: 'rcpt-2' },
        authorization: {
          profileId: 'charge@0.5',
          boundsHash: 'sha256:bounds123',
          attestations: [
            { domain: 'payments', blob: 'blob-1', expiresAt: 2000000000 }, // seen
            { domain: 'privacy', blob: 'blob-2', expiresAt: 2000000000 }, // new
          ],
        },
      }),
    );

    const auths = archive.getAuthorizations();
    expect(auths).toHaveLength(1);
    expect(auths[0].attestations).toHaveLength(2);
  });

  it('archives the review-path proposal — what the human approved, not just its id', () => {
    const archive = new ReceiptArchive(testDir);
    archive.record(makeEntry({
      proposal: {
        id: 'prop-1',
        tool: 'gmail__send_message',
        toolArgs: { to: ['a@b.c'], subject: 'Hi', body: 'Approved text' },
        committedBy: { finance: { userId: 'u1', at: 1735888000 } },
        status: 'executed',
      },
    }));

    const stored = new ReceiptArchive(testDir).getReceipts()[0];
    expect(stored.proposal?.id).toBe('prop-1');
    // The approved content itself must survive — that is the whole point.
    expect((stored.proposal?.toolArgs as Record<string, unknown>).body).toBe('Approved text');
    expect(stored.proposal?.committedBy).toEqual({ finance: { userId: 'u1', at: 1735888000 } });
  });

  it('strips the image preview blob but keeps the path', () => {
    const archive = new ReceiptArchive(testDir);
    archive.record(makeEntry({
      proposal: {
        id: 'prop-2',
        toolArgs: {
          imagePath: '/tmp/pic.png',
          _imagePreview: 'data:image/png;base64,' + 'A'.repeat(5000),
        },
      },
    }));

    const args = archive.getReceipts()[0].proposal?.toolArgs as Record<string, unknown>;
    expect(args._imagePreview).toBeUndefined();
    expect(args.imagePath).toBe('/tmp/pic.png');
  });

  it('archives the bound content — the automatic path has no proposal to carry it', () => {
    const archive = new ReceiptArchive(testDir);
    archive.record(makeEntry({
      boundContent: { to: ['a@b.c'], subject: 'Hi', body: 'What actually went out' },
    }));

    const stored = new ReceiptArchive(testDir).getReceipts()[0];
    expect(stored.boundContent).toEqual({
      to: ['a@b.c'], subject: 'Hi', body: 'What actually went out',
    });
    // No proposal on this path — the content is the only reproduction of it.
    expect(stored.proposal).toBeUndefined();
  });

  it('archives a text binding as the bound string', () => {
    const archive = new ReceiptArchive(testDir);
    archive.record(makeEntry({ boundContent: 'the post text that was published' }));
    expect(archive.getReceipts()[0].boundContent).toBe('the post text that was published');
  });

  it('archives a receipt even without authorization info (evicted cache)', () => {
    const archive = new ReceiptArchive(testDir);
    archive.record(makeEntry({ authorization: undefined }));
    expect(archive.size).toBe(1);
    expect(archive.getAuthorizations()).toHaveLength(0);
  });

  it('never prunes — old receipts remain', () => {
    const archive = new ReceiptArchive(testDir);
    // A receipt archived years in the past (timestamp 2020) must survive
    // arbitrarily many later records.
    archive.record(makeEntry(), 1577836800);
    archive.record(makeEntry({ receipt: { ...makeEntry().receipt, id: 'rcpt-new' } }));
    expect(archive.size).toBe(2);
    expect(archive.getReceipts()[0].archivedAt).toBe(1577836800);
  });

  it('encrypts on setVaultKey, migrating and removing the plaintext file', () => {
    const archive = new ReceiptArchive(testDir);
    archive.record(makeEntry());
    expect(existsSync(join(testDir, 'receipt-archive.json'))).toBe(true);

    const key = makeVaultKey();
    archive.setVaultKey(key);

    expect(existsSync(join(testDir, 'receipt-archive.enc.json'))).toBe(true);
    expect(existsSync(join(testDir, 'receipt-archive.json'))).toBe(false);

    const raw = readFileSync(join(testDir, 'receipt-archive.enc.json'), 'utf-8');
    expect(raw).not.toContain('rcpt-1');
    expect(raw).not.toContain('bounds123');

    // Reopen with the key: data intact.
    const reopened = new ReceiptArchive(testDir);
    reopened.setVaultKey(key);
    expect(reopened.size).toBe(1);
    expect(reopened.getReceipts()[0].receipt.id).toBe('rcpt-1');
  });

  it('reports locked when encrypted evidence exists without a key — never "empty"', () => {
    const archive = new ReceiptArchive(testDir);
    expect(archive.isLocked()).toBe(false); // nothing encrypted yet

    archive.record(makeEntry());
    const key = makeVaultKey();
    archive.setVaultKey(key);

    const reopened = new ReceiptArchive(testDir);
    expect(reopened.isLocked()).toBe(true); // enc file on disk, no key
    reopened.setVaultKey(key);
    expect(reopened.isLocked()).toBe(false);
    expect(reopened.size).toBe(1);
  });

  it('preserves a corrupt plaintext file aside instead of overwriting it', () => {
    const path = join(testDir, 'receipt-archive.json');
    writeFileSync(path, '{not json', 'utf-8');

    const archive = new ReceiptArchive(testDir);
    archive.record(makeEntry());

    const corrupt = readdirSync(testDir).filter(f => f.includes('.corrupt-'));
    expect(corrupt).toHaveLength(1);
    expect(readFileSync(join(testDir, corrupt[0]), 'utf-8')).toBe('{not json');
    // And the archive keeps working.
    expect(new ReceiptArchive(testDir).size).toBe(1);
  });

  it('preserves an undecryptable encrypted file aside (wrong key) instead of overwriting', () => {
    const archive = new ReceiptArchive(testDir);
    archive.record(makeEntry());
    archive.setVaultKey(makeVaultKey());
    const encPath = join(testDir, 'receipt-archive.enc.json');
    const original = readFileSync(encPath, 'utf-8');

    const reopened = new ReceiptArchive(testDir);
    reopened.setVaultKey(makeVaultKey()); // different key — decrypt fails

    const corrupt = readdirSync(testDir).filter(f => f.includes('.corrupt-'));
    expect(corrupt).toHaveLength(1);
    expect(readFileSync(join(testDir, corrupt[0]), 'utf-8')).toBe(original);
  });
});
