/**
 * Arguments a connector offers that would bypass every control.
 *
 * A downstream server's schema reaches the agent unchanged, so a connector can
 * hand out a bypass just by offering one. Gmail's `send_message` takes `raw` —
 * a whole pre-encoded message — and its own description says raw causes
 * to/cc/subject/body to be ignored. Every control reads those fields: the
 * recipient scope, the content binding, the approval card. A call using `raw`
 * carried its recipients and its text past all three.
 *
 * Two halves, and the second is the one that counts: hiding the argument keeps
 * an honest agent out of trouble; refusing the call is what makes it a control.
 */
import { describe, it, expect } from 'vitest';
import { withoutBlockedArgs } from '../src/lib/integration-manager';
import { createGatedToolHandler } from '../src/lib/tool-proxy';

const GMAIL_SEND = {
  type: 'object',
  properties: {
    to: { type: 'array' },
    subject: { type: 'string' },
    body: { type: 'string' },
    raw: { type: 'string' },
  },
  required: ['to', 'raw'],
};

describe('withoutBlockedArgs', () => {
  it('removes the blocked property from what the agent is shown', () => {
    const out = withoutBlockedArgs(GMAIL_SEND, ['raw']);
    expect(Object.keys(out.properties as object)).toEqual(['to', 'subject', 'body']);
  });

  it('also drops it from `required`', () => {
    // A required property that no longer exists makes the schema invalid for a
    // strict client, which would break the whole tool rather than one argument.
    const out = withoutBlockedArgs(GMAIL_SEND, ['raw']);
    expect(out.required).toEqual(['to']);
  });

  it('does not mutate the downstream schema', () => {
    // The object belongs to the connector and is reused across discoveries.
    withoutBlockedArgs(GMAIL_SEND, ['raw']);
    expect(Object.keys(GMAIL_SEND.properties)).toContain('raw');
    expect(GMAIL_SEND.required).toContain('raw');
  });

  it('leaves everything alone when nothing is blocked', () => {
    expect(withoutBlockedArgs(GMAIL_SEND, undefined)).toBe(GMAIL_SEND);
    expect(withoutBlockedArgs(GMAIL_SEND, [])).toBe(GMAIL_SEND);
  });

  it('survives a schema with no properties', () => {
    expect(withoutBlockedArgs({ type: 'object' }, ['raw'])).toEqual({ type: 'object' });
  });
});

describe('the gmail manifest', () => {
  it('blocks `raw` on both tools that can transmit', async () => {
    // create_draft matters as much as send_message: a draft built from `raw`
    // has recipients nobody checked, and send_draft will happily send it.
    const manifest = await import('../../../content/integrations/gmail.json');
    const overrides = (manifest.default as { toolGating: { overrides: Record<string, { blockedArgs?: string[] }> } })
      .toolGating.overrides;

    expect(overrides.send_message.blockedArgs).toContain('raw');
    expect(overrides.create_draft.blockedArgs).toContain('raw');
  });
});

describe('the refusal itself', () => {
  // The layer that matters, and the one a well-behaved client hides. A live
  // send with `raw` proved only that the MCP client drops unknown arguments
  // before the gateway sees them — the guard never fired, so nothing about it
  // was demonstrated. It exists for clients that do NOT validate, which is
  // exactly the case no manual test can produce.
  const tool = {
    namespacedName: 'gmail__send_message',
    originalName: 'send_message',
    integrationId: 'gmail',
    description: '',
    inputSchema: {},
    gating: { profile: 'email@0.4', executionMapping: {}, blockedArgs: ['raw'] },
  } as unknown as Parameters<typeof createGatedToolHandler>[0];

  /** Reaching either of these means the guard did not short-circuit. */
  const explode = new Proxy({}, { get() { throw new Error('guard did not short-circuit'); } });

  it('refuses the call when a blocked argument is present', async () => {
    const handler = createGatedToolHandler(tool, explode as never, explode as never);
    const result = await handler({ to: ['a@example.com'], raw: 'blob' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/refused/i);
    expect(result.content[0].text).toContain('"raw"');
  });

  it('refuses before any authorization work happens', async () => {
    // The stubs throw on any property access, so this passing IS the assertion:
    // nothing downstream was consulted. A blocked argument means we cannot
    // reason about the call at all, so there is nothing later worth running.
    const handler = createGatedToolHandler(tool, explode as never, explode as never);
    await expect(handler({ raw: 'blob' })).resolves.toBeDefined();
  });

  it('leaves an ordinary call alone', async () => {
    // Without the blocked argument the wrapper must delegate — if it swallowed
    // every call the tool would be dead rather than guarded.
    const handler = createGatedToolHandler(tool, explode as never, explode as never);
    await expect(handler({ to: ['a@example.com'], body: 'hi' })).rejects.toThrow(
      'guard did not short-circuit',
    );
  });
});
