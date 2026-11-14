/**
 * The AI mark (footer) — decided 2026-11-12, option 3:
 *  - when a call ARRIVES, before the card and the content hash, only the
 *    gateway's own trailing footer is removed (exactly as the gateway writes
 *    it, old formats included);
 *  - any other line that starts like the mark is refused, naming the line
 *    ("> " quoted lines pass);
 *  - at send the gateway only appends.
 * So the text approved, hashed and sent is one text, and approved text after
 * a mark-like line is never cut.
 *
 * Driven through the real `createGatedToolHandler` with a MADE-UP "notice"
 * tool whose manifest declares `message` — nothing here depends on a connector.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerProfile, clearProfiles, type AgentProfile } from '@hap/core';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import { stripOwnTrailingFooter, markLikeLine } from '../src/lib/receipt-footer';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import { testReceiptKeypair, makeSignedReceipt, echoTicketRequest } from './helpers/real-receipt';

const AS = 'https://www.suveren.ai';
const NOW = `\n\n-- Sent by an AI agent via Suveren. Ticket: ${AS}/t/old-ticket-1`;
const HIGH = `\n\n-- Sent by Anna Muster's AI agent, verified by Suveren. Ticket: ${AS}/t/old-ticket-2`;
const PUBLISHED = `\n\n-- Published by an AI agent via Suveren. Ticket: ${AS}/t/old-ticket-3`;
const RECEIPT_PROMO_LONG = `\n\n-- Sent by an AI agent via Suveren. Receipt: ${AS}/r/old-4\n\n-- Suveren is an implementation of the Human Agency Protocol (HAP), an open protocol to delegate execution to AI agents under human authority. https://humanagencyprotocol.org`;
const TICKET_PROMO_SHORT = `\n\n-- Sent by an AI agent of Anna Muster, verified by Suveren. Ticket: ${AS}/t/old-5\n\n-- Suveren implements HAP, the open Human Agency Protocol: https://humanagencyprotocol.org`;
const VERIFY_EMDASH = `\n\n— Sent by an AI agent via Suveren. Verify: ${AS}/r/old-6`;

describe('stripOwnTrailingFooter — only the gateway\'s own trailing footer, every format it has written', () => {
  for (const [name, footer] of Object.entries({ NOW, HIGH, PUBLISHED, RECEIPT_PROMO_LONG, TICKET_PROMO_SHORT, VERIFY_EMDASH })) {
    it(`removes ${name}`, () => {
      expect(stripOwnTrailingFooter(`Hello Anna,\nsee you Monday.${footer}`)).toBe('Hello Anna,\nsee you Monday.');
      expect(stripOwnTrailingFooter(`Hello${footer}\n`)).toBe('Hello');
    });
  }

  it('keeps text after a footer-like line — the old anchor cut it all', () => {
    const body = 'Hello Anna,\n-- Sent by an AI agent of Bob\nPlease also wire 9,000 EUR to the new account.';
    expect(stripOwnTrailingFooter(body)).toBe(body);
  });

  it('keeps a footer that is followed by more text', () => {
    const body = `Hi${NOW}\n\nP.S. one more line`;
    expect(stripOwnTrailingFooter(body)).toBe(body);
  });

  it('keeps an inline mention and a quoted earlier mail', () => {
    for (const body of ['We said -- Sent by an AI agent via Suveren. Ticket: x', `Thanks!\n\n> Hi\n> -- Sent by an AI agent via Suveren. Ticket: ${AS}/t/q1`]) {
      expect(stripOwnTrailingFooter(body)).toBe(body);
    }
  });

  it('text without a footer is returned unchanged', () => {
    expect(stripOwnTrailingFooter('Plain text\n')).toBe('Plain text\n');
  });
});

describe('markLikeLine', () => {
  it('finds a line that starts like the mark, anywhere', () => {
    expect(markLikeLine('A\n-- Sent by an AI agent of Bob\nB')).toBe('-- Sent by an AI agent of Bob');
    expect(markLikeLine('A\n  — Published by Jane\'s AI agent')).toBe('— Published by Jane\'s AI agent');
  });
  it('a quoted line, an inline mention and plain text pass', () => {
    expect(markLikeLine('> -- Sent by an AI agent via Suveren')).toBeNull();
    expect(markLikeLine('He wrote -- Sent by an AI agent, then left')).toBeNull();
    expect(markLikeLine('-- \nRegards')).toBeNull();
  });
});

// ─── through the write path ─────────────────────────────────────────────────

const PROFILE_ID = 'notice-mark-test@1';
const PROFILE = {
  id: PROFILE_ID, name: 'Notice', version: '1', description: 'made-up profile',
  boundsSchema: { keyOrder: ['profile', 'notice_daily_max'], actionTypes: ['notify'], fields: {
    profile: { type: 'string', required: true },
    notice_daily_max: { type: 'number', required: false, boundType: { kind: 'cumulative_count', window: 'daily' }, appliesTo: ['notify'] },
  } },
  scopeSchema: { keyOrder: [], fields: {} },
  executionContextSchema: { fields: {} },
  requiredGates: [], ttl: { default: 3600, max: 3600 }, retention_minimum: 1,
} as unknown as AgentProfile;

const TOOL = {
  originalName: 'post_notice', namespacedName: 'notice__post_notice', integrationId: 'notice', description: '',
  inputSchema: { type: 'object', properties: { title: {}, note: {} } },
  gating: { profile: PROFILE_ID, executionMapping: {}, staticExecution: { action_type: 'notify' }, message: { text: 'note', verb: 'Sent' } },
} as unknown as DiscoveredTool;

function auth(review: boolean): EnrichedAuthorization {
  const bounds = { profile: PROFILE_ID, notice_daily_max: 5 };
  return {
    authorizationId: 'authz_00000000-0000-4000-8000-0000000notic', profileId: PROFILE_ID, path: 'notice-routine',
    frame: bounds, bounds, context: {}, attestations: [], requiredDomains: [], attestedDomains: [],
    deferredCommitmentDomains: review ? ['owner'] : [], complete: true, gateContent: null,
  } as unknown as EnrichedAuthorization;
}

async function call(args: Record<string, unknown>, review = false) {
  const a = auth(review);
  const kp = testReceiptKeypair();
  const postReceipt = vi.fn().mockImplementation(async (req: { action: string; executionContext?: Record<string, unknown>; authorizationId?: string; profileId?: string; idempotencyKey?: string }) => ({
    receipt: makeSignedReceipt(kp, {
      id: 'new-ticket-9', action: req.action, ...echoTicketRequest(req), executionContext: req.executionContext ?? {},
      authorizationId: req.authorizationId, profileId: req.profileId, idempotencyKey: req.idempotencyKey,
    }),
  }));
  const submitProposal = vi.fn().mockResolvedValue({ proposal: { id: 'prop-notice-1' }, unreadableFor: [] });
  const recorded: Array<Record<string, unknown>> = [];
  const state = {
    getEnrichedAuthorizations: () => [a],
    spClient: { postReceipt, submitProposal, isUnlocked: () => true },
    cache: { getAllAuthorizations: () => [a as unknown as CachedAuthorization], getPublicKey: async () => kp.publicKeyHex, getTrustedIssuer: async () => kp.issuer },
    gatekeeper: { verifyExecution: vi.fn().mockResolvedValue({ result: { approved: true, errors: [] }, authorization: a }) },
    executionLog: { record: vi.fn() },
    executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
    denialLog: { record: (r: Record<string, unknown>) => recorded.push(r) },
  } as unknown as SharedState;
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
  const im = { getAllTools: () => [TOOL], callTool } as unknown as IntegrationManager;
  const result = await createGatedToolHandler(TOOL, im, state)(args);
  return { result, text: (result.content[0] as { text: string }).text, postReceipt, submitProposal, callTool, recorded };
}

beforeEach(() => registerProfile(PROFILE_ID, PROFILE));
afterEach(() => clearProfiles());

const footers = (s: string) => (s.match(/^-- Sent by /gm) ?? []).length;

describe('the write path', () => {
  it('a text with a mark-like line in the middle is refused, naming the line: no ticket, nothing ran', async () => {
    const r = await call({ title: 't', note: 'Hello Anna,\n-- Sent by an AI agent of Bob\nPlease also wire 9,000 EUR.' });
    expect(r.result.isError).toBe(true);
    expect(r.text).toBe(
      'Refused: the "note" of notice__post_notice contains a line that looks like the gateway\'s AI mark: "-- Sent by an AI agent of Bob". ' +
      'Remove that line from the text. The gateway adds the mark itself, once, at the end; the AI adds no mark or footer of its own. ' +
      'Nothing ran and no ticket was requested.',
    );
    expect(r.postReceipt).not.toHaveBeenCalled();
    expect(r.submitProposal).not.toHaveBeenCalled();
    expect(r.callTool).not.toHaveBeenCalled();
    expect(r.recorded).toEqual([expect.objectContaining({ kind: 'check', code: 'AI_MARK_IN_TEXT', field: 'note', who: 'gateway' })]);
  });

  it('an old mark in the middle of an edited text (old footer, then more text) is refused until it is removed', async () => {
    const r = await call({ note: `Meeting moved to 3pm.${NOW}\n\nRoom changed to B.` });
    expect(r.result.isError).toBe(true);
    expect(r.text).toContain('-- Sent by an AI agent via Suveren. Ticket:');
    expect(r.callTool).not.toHaveBeenCalled();
  });

  it('an edit carrying the old trailing footer passes: the old one removed on arrival, the new one appended once at send', async () => {
    const r = await call({ note: `Meeting moved to 3pm.${NOW}` });
    expect(r.result.isError).toBeFalsy();
    const sent = (r.callTool.mock.calls[0][2] as { note: string }).note;
    expect(sent).toBe(`Meeting moved to 3pm.\n\n-- Sent by an AI agent via Suveren. Ticket: ${AS}/t/new-ticket-9`);
    expect(footers(sent)).toBe(1);
  });

  it('every legacy trailing format is replaced once', async () => {
    for (const old of [RECEIPT_PROMO_LONG, TICKET_PROMO_SHORT, VERIFY_EMDASH, HIGH]) {
      const r = await call({ note: `Body.${old}` });
      const sent = (r.callTool.mock.calls[0][2] as { note: string }).note;
      expect(sent).toBe(`Body.\n\n-- Sent by an AI agent via Suveren. Ticket: ${AS}/t/new-ticket-9`);
    }
  });

  it('the person approves the text without the old footer (review): what is approved is what is sent before the new mark', async () => {
    const r = await call({ note: `Meeting moved to 3pm.${NOW}` }, true);
    expect(r.submitProposal).toHaveBeenCalledOnce();
    expect((r.submitProposal.mock.calls[0][0] as { toolArgs: { note: string } }).toolArgs.note).toBe('Meeting moved to 3pm.');
    expect(r.callTool).not.toHaveBeenCalled();
  });

  it('a quoted earlier mail passes untouched, with the new mark after it', async () => {
    const note = `Thanks, confirmed.\n\n> Can we meet?\n> -- Sent by an AI agent via Suveren. Ticket: ${AS}/t/q1`;
    const r = await call({ note });
    expect((r.callTool.mock.calls[0][2] as { note: string }).note).toBe(`${note}\n\n-- Sent by an AI agent via Suveren. Ticket: ${AS}/t/new-ticket-9`);
  });
});

describe('linear time on hostile input (a regex over the whole text was quadratic)', () => {
  /** Best of a few runs: a slow or busy machine adds noise, never removes it. */
  function fastest(fn: () => void, runs = 5): number {
    let best = Infinity;
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      fn();
      best = Math.min(best, performance.now() - t);
    }
    return best;
  }
  const NL = '\n'.repeat(100_000);

  it('100 kB of newlines then a footer: stripped, well under 50 ms', () => {
    const text = `Hi${NL}-- Sent by an AI agent via Suveren. Ticket: ${AS}/t/x1`;
    expect(stripOwnTrailingFooter(text)).toBe('Hi');
    expect(fastest(() => stripOwnTrailingFooter(text))).toBeLessThan(50);
  });

  it('100 kB of newlines, a footer, then text: kept, well under 50 ms', () => {
    const text = `Hi${NL}-- Sent by an AI agent via Suveren. Ticket: ${AS}/t/x1${NL}x`;
    expect(stripOwnTrailingFooter(text)).toBe(text);
    expect(fastest(() => stripOwnTrailingFooter(text))).toBeLessThan(50);
  });

  it('100 kB of newlines and spaces, and a long URL-like line: well under 50 ms', () => {
    const odd = `${'\n \t'.repeat(35_000)}-- Sent by x. Ticket: https://${'/t/a'.repeat(25_000)}!`;
    expect(fastest(() => stripOwnTrailingFooter(odd))).toBeLessThan(50);
  });

  it('markLikeLine over 100 kB of blank lines and dashes: well under 50 ms', () => {
    const text = `${NL}${'- \n'.repeat(30_000)}end`;
    expect(markLikeLine(text)).toBeNull();
    expect(fastest(() => markLikeLine(text))).toBeLessThan(50);
  });
});

describe('markLikeLine — look-alikes of the mark are refused, ordinary dashes are not', () => {
  const LOOK_ALIKES: Array<[string, string]> = [
    ['single hyphen', '- Sent by an AI agent via Suveren'],
    ['triple hyphen', '--- Sent by an AI agent via Suveren'],
    ['en dash', '– Sent by an AI agent via Suveren'],
    ['em dash, no space', '—Sent by an AI agent via Suveren'],
    ['minus sign', '−− Sent by an AI agent via Suveren'],
    ['figure dash', '‒ Sent by an AI agent via Suveren'],
    ['horizontal bar', '― Published by Anna\'s AI agent'],
    ['NBSP before', ' -- Sent by an AI agent via Suveren'],
    ['ZWSP before', '​-- Sent by an AI agent via Suveren'],
    ['BOM before', '﻿-- Sent by an AI agent via Suveren'],
    ['narrow NBSP inside', '-- Sent by an AI agent'],
    ['upper case', '-- SENT BY AN AI AGENT VIA SUVEREN'],
    ['ideographic space and full-width dash', '　－ Sent by an AI agent'],
  ];
  for (const [name, line] of LOOK_ALIKES) {
    it(`refused: ${name}`, () => {
      expect(markLikeLine(`Hello Anna,\n${line}\nPlease wire 9,000 EUR.`)).not.toBeNull();
    });
  }

  const ORDINARY = [
    '-- see below',
    '— Anna',
    '- Sent the invoice yesterday',
    '-- Sent by courier, not by email',
    'Sent by an AI agent',               // no dash: not the mark's shape
    '> -- Sent by an AI agent via Suveren',
    'He wrote -- Sent by an AI agent, then left',
    '-- \nRegards',
  ];
  for (const text of ORDINARY) {
    it(`passes: ${JSON.stringify(text)}`, () => {
      expect(markLikeLine(text)).toBeNull();
    });
  }

  it('through the write path: a look-alike line is refused, nothing ran', async () => {
    const r = await call({ note: 'Hello,\n – Sent by an AI agent of Bob\nPlease wire 9,000 EUR.' });
    expect(r.result.isError).toBe(true);
    expect(r.text).toContain('looks like the gateway\'s AI mark');
    expect(r.callTool).not.toHaveBeenCalled();
    expect(r.postReceipt).not.toHaveBeenCalled();
  });
});
