/**
 * The committed-proposal poll loop (bin/http.ts) must never log
 * "Auto-executed" for a proposal that was SKIPPED (e.g. one another gateway
 * of the same operator submitted — see commitments.ts's cross-device skip
 * and test/commit-cross-device-skip.test.ts for the "nothing ran" half of
 * this guarantee). This pins the logging decision itself:
 *   - skipped → log nothing (not every 5s, not once)
 *   - executed → the "Auto-executed" line, naming the tool
 *   - errored → the "Auto-exec ... <reason>" line (unchanged)
 */
import { describe, it, expect } from 'vitest';
import { describeAutoExecutionLog, type ExecutionResult } from '../src/lib/committed-executor';

describe('describeAutoExecutionLog', () => {
  it('logs nothing for a skipped (foreign) proposal — not misleadingly "Auto-executed"', () => {
    const result: ExecutionResult = { text: 'approved, but submitted elsewhere — re-run here', skipped: true };
    expect(describeAutoExecutionLog('prop-foreign-1', 'records__create_record', result)).toBeNull();
  });

  it('logs "Auto-executed" once for a proposal this gateway actually ran', () => {
    const result: ExecutionResult = { text: 'ok' };
    const line = describeAutoExecutionLog('prop-own-1', 'records__create_record', result);
    expect(line).toBe('[Suveren MCP] Auto-executed proposal prop-own-1: records__create_record');
  });

  it('still logs the failure reason for a real execution error (unchanged)', () => {
    const result: ExecutionResult = { text: 'downstream tool refused', isError: true };
    const line = describeAutoExecutionLog('prop-err-1', 'records__create_record', result);
    expect(line).toBe('[Suveren MCP] Auto-exec proposal prop-err-1: downstream tool refused');
  });

  it('an errored-and-skipped combination (should not occur) still prefers skipped → no log', () => {
    // Defensive: skipped is the "nothing ran" signal regardless of isError.
    const result: ExecutionResult = { text: 'x', isError: true, skipped: true };
    expect(describeAutoExecutionLog('prop-both-1', 'x__y', result)).toBeNull();
  });
});
