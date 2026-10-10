/**
 * AU4 — ProposalSubmissionStore carries an optional previewHash snapshot
 * (see preview.ts's computeSubmissionPreviewHash), read back by
 * commitments.ts's executeCommitted before it runs the tool.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProposalSubmissionStore } from '../src/lib/proposal-submission-store';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('ProposalSubmissionStore — previewHash', () => {
  it('round-trips a previewHash when one is given', () => {
    dir = mkdtempSync(join(tmpdir(), 'hap-submission-store-'));
    const store = new ProposalSubmissionStore(dir);
    store.record({
      proposalId: 'p1',
      tool: 'erp__send_quote',
      toolArgs: { id: 'Q1', value: 100 },
      executionContext: { action_type: 'send' },
      authorizationId: 'authz_1',
      profileId: 'sales',
      previewHash: 'sha256:abc',
    });
    expect(store.get('p1')?.previewHash).toBe('sha256:abc');
  });

  it('omits previewHash entirely when none is given — never invents an empty one', () => {
    dir = mkdtempSync(join(tmpdir(), 'hap-submission-store-'));
    const store = new ProposalSubmissionStore(dir);
    store.record({
      proposalId: 'p1',
      tool: 'erp__create_quote',
      toolArgs: { value: 100 },
      executionContext: { action_type: 'quote' },
      authorizationId: 'authz_1',
      profileId: 'sales',
    });
    expect(store.get('p1')?.previewHash).toBeUndefined();
  });

  it('survives a re-read from disk (cross-process semantics)', () => {
    dir = mkdtempSync(join(tmpdir(), 'hap-submission-store-'));
    const a = new ProposalSubmissionStore(dir);
    a.record({
      proposalId: 'p1',
      tool: 'erp__send_quote',
      toolArgs: { id: 'Q1' },
      executionContext: {},
      authorizationId: 'authz_1',
      profileId: 'sales',
      previewHash: 'sha256:xyz',
    });
    const b = new ProposalSubmissionStore(dir);
    expect(b.get('p1')?.previewHash).toBe('sha256:xyz');
  });
});
