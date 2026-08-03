/**
 * Receipt summaries — readable without becoming untrue.
 *
 * The trap this pins: Gmail's `send_message` and `create_draft` BOTH carry
 * `action_type: "send"`. Any label derived from the action type would report a
 * saved draft as a sent email — trading an ugly card for a lying one. The label
 * therefore comes from the connector manifest, and an undeclared tool falls
 * back to something flat and true.
 */
import { describe, it, expect } from 'vitest';
import { actionLabel, scopeSummary, wasReviewed, profileVersionLabel, splitAction } from './receipt-summary';
import type { ExecutionReceipt, IntegrationManifest } from './sp-client';

const GMAIL = {
  id: 'gmail',
  toolGating: {
    overrides: {
      send_message: { actionLabel: 'Email sent' },
      create_draft: { actionLabel: 'Email drafted' },
      trash_message: null,
    },
  },
} as unknown as IntegrationManifest;

const receipt = (over: Partial<ExecutionReceipt> = {}): ExecutionReceipt => ({
  id: 'fe879f56-224c-4535-a258-2ce66fdf4fda',
  groupId: 'g', userId: 'u',
  attestationHash: 'sha256:abc',
  profileId: 'github.com/humanagencyprotocol/hap-profiles/email@0.5',
  path: 'email@0.5',
  action: 'gmail__send_message',
  executionContext: { action_type: 'send' },
  cumulativeState: { daily: { amount: 0, count: 1 }, monthly: { amount: 0, count: 1 } },
  timestamp: 0, signature: 's',
  ...over,
});

describe('actionLabel — declared, never inferred', () => {
  it('distinguishes a send from a draft, though both are action_type "send"', () => {
    const sent = receipt({ action: 'gmail__send_message' });
    const drafted = receipt({ action: 'gmail__create_draft' });
    expect(sent.executionContext.action_type).toBe(drafted.executionContext.action_type);
    expect(actionLabel(sent, [GMAIL])).toBe('Email sent');
    expect(actionLabel(drafted, [GMAIL])).toBe('Email drafted');
  });

  it('falls back to flat-but-true when a tool declares no label', () => {
    expect(actionLabel(receipt({ action: 'gmail__trash_message' }), [GMAIL]))
      .toBe('Email · send');
  });

  it('falls back when the manifest is missing entirely', () => {
    expect(actionLabel(receipt(), [])).toBe('Email · send');
  });

  it('never claims an action it cannot name', () => {
    const label = actionLabel(
      receipt({ action: 'unknown__mystery', executionContext: {} }),
      [],
    );
    expect(label).toContain('mystery');
    expect(label).not.toMatch(/sent|created|published/i);
  });
});

describe('scopeSummary — scope only, because receipts carry no content', () => {
  it('reads allowed_* fields without knowing any profile', () => {
    expect(scopeSummary(receipt({
      executionContext: {
        action_type: 'send',
        recipient_count: 2,
        allowed_recipients: 'andreas@sublin.app,second@x.com',
      },
    }))).toBe('andreas@sublin.app, second@x.com');
  });

  it('works the same for a different profile with different fields', () => {
    expect(scopeSummary(receipt({
      executionContext: { action_type: 'release', allowed_environments: 'production' },
    }))).toBe('production');
  });

  it('says nothing rather than filler when a profile has no scope', () => {
    expect(scopeSummary(receipt({ executionContext: { action_type: 'write' } }))).toBe('');
  });

  it('omits counts and action_type — they are not scope', () => {
    const out = scopeSummary(receipt({
      executionContext: { action_type: 'send', recipient_count: 2, allowed_recipients: 'a@x.com' },
    }));
    expect(out).toBe('a@x.com');
    expect(out).not.toMatch(/send|2/);
  });
});

describe('supporting bits', () => {
  it('review mode is signalled by the proposal a human approved', () => {
    expect(wasReviewed(receipt({ proposalId: 'b0ce75dbdcdb' }))).toBe(true);
    expect(wasReviewed(receipt())).toBe(false);
  });

  it('keeps the profile version — after 0.5 it says whether recipients are bound', () => {
    expect(profileVersionLabel('github.com/humanagencyprotocol/hap-profiles/email@0.5'))
      .toBe('Email@0.5');
  });

  it('splits a namespaced tool name', () => {
    expect(splitAction('gmail__send_message')).toEqual({ integrationId: 'gmail', toolName: 'send_message' });
    expect(splitAction('bare')).toEqual({ integrationId: '', toolName: 'bare' });
  });
});
