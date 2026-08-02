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
