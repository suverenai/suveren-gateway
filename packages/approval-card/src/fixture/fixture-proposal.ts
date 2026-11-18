/**
 * Fixture proposals for rendering the approval card outside the gateway app.
 * Invented data only. One proposal is a legacy row (plain `toolArgs`), one is
 * sealed (`content`), so both paths of the decrypt code are exercised.
 */
import type { Proposal } from '../types';

const NOW = 1_800_000_000;

const base = {
  authorizationId: 'auth-fixture-1',
  profileId: 'email@0.4',
  path: 'email/send',
  pendingDomains: ['owner'],
  committedBy: {},
  rejectedBy: null,
  tool: 'email__send_email',
  executionContext: {} as Record<string, string | number>,
  status: 'pending' as const,
  executionResult: null,
  createdAt: NOW,
  expiresAt: NOW + 3600,
  createdBy: 'fixture-owner',
};

export const FIXTURE_TOOL_ARGS = {
  to: 'maria.huber@example.com',
  subject: 'Your offer',
  body: 'Hello Maria,\n\nHere is the offer we talked about.\n\nBest regards',
};

/** A legacy row: the arguments travel in the clear. */
export const FIXTURE_PLAIN_PROPOSAL: Proposal = {
  ...base,
  id: 'fixture-plain',
  toolArgs: FIXTURE_TOOL_ARGS,
};

/** A sealed row: the arguments must be opened with this device's key (the fixture host stands in for it). */
export const FIXTURE_SEALED_PROPOSAL: Proposal = {
  ...base,
  id: 'fixture-sealed',
  content: {
    v: 1,
    alg: 'fixture',
    ciphertext: 'fixture-ciphertext',
    keys: { 'fixture-owner': { ct: 'fixture', enc: 'fixture' } },
    hash: 'sha256:fixture',
  },
};
