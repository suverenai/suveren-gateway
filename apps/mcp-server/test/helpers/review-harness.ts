/**
 * A review-mode mandate harness for createGatedToolHandler: a call that passes
 * becomes a proposal (`submitProposal`), a refusal is recorded on `denials`.
 * Authority Server, Gatekeeper verdict and connector are doubles; the
 * handler, preview reads and checks are the real gateway code.
 */
import { vi } from 'vitest';
import type { SharedState, EnrichedAuthorization } from '../../src/lib/shared-state';
import type { CachedAuthorization } from '../../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../../src/lib/integration-manager';

/** A review-mode mandate: a passing call becomes a proposal (a card). */
export function reviewHarness(profileId: string, tools: DiscoveredTool[], answer: (tool: string, args: Record<string, unknown>) => unknown) {
  const auth = {
    authorizationId: 'authz_blocking', profileId, path: 'p', frame: { profile: profileId },
    attestations: [], requiredDomains: [], attestedDomains: [], complete: true, deferredCommitmentDomains: ['owner'],
  } as unknown as CachedAuthorization;
  const submitProposal = vi.fn().mockResolvedValue({ proposal: { id: 'prop-1' }, unreadableFor: [] });
  const denials = vi.fn();
  const state = {
    getEnrichedAuthorizations: () => [{ ...auth, gateContent: null } as EnrichedAuthorization],
    spClient: { postReceipt: vi.fn(), submitProposal, isUnlocked: () => true, getAuthorizationSummary: vi.fn().mockResolvedValue(null) },
    cache: { getAllAuthorizations: () => [auth] },
    proposalSubmissions: { record: vi.fn(), get: () => undefined },
    gatekeeper: { verifyExecution: vi.fn().mockResolvedValue({ result: { approved: true, errors: [] }, authorization: auth }) },
    executionLog: { record: vi.fn() },
    denialLog: { record: denials },
    executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharedState;
  const callTool = vi.fn().mockImplementation(async (_i: string, tool: string, args: Record<string, unknown>) => {
    const a = answer(tool, args);
    if (a === undefined) return { isError: true, content: [{ type: 'text', text: 'unavailable' }] };
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: a };
  });
  const im = { getAllTools: () => tools, callTool, isBuiltin: () => false } as unknown as IntegrationManager;
  return { state, im, submitProposal, denials, callTool };
}

