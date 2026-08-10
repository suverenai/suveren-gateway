import { describe, it, expect } from 'vitest';
import { explainEmptyReply, CHAT_TOKEN_BUDGET } from '../lib/ai-client';

/**
 * A 200 with no text used to become the single string "No response generated."
 * — which is what the AI assistant showed the user, and which says nothing
 * about the cause or the fix. The provider always explains itself; these pin
 * that we pass the explanation on.
 */
describe('explainEmptyReply', () => {
  it('names the reasoning-budget case, with the number', () => {
    const msg = explainEmptyReply(
      { finish_reason: 'length', message: { content: '' } },
      { completion_tokens_details: { reasoning_tokens: 4000 } },
      CHAT_TOKEN_BUDGET,
    );
    expect(msg).toContain('reasoning model');
    expect(msg).toContain('4000');
    // It must say what to DO, not only what happened.
    expect(msg).toMatch(/Raise the token limit|non-reasoning model/);
  });

  it('distinguishes plain truncation from reasoning exhaustion', () => {
    const msg = explainEmptyReply({ finish_reason: 'length' }, {}, 4000);
    expect(msg).toContain('token limit');
    expect(msg).not.toContain('reasoning model');
  });

  it('catches a model that returns only reasoning content', () => {
    const msg = explainEmptyReply(
      { finish_reason: 'stop', message: { content: '', reasoning_content: 'thinking…' } },
      {},
      4000,
    );
    expect(msg).toContain('only internal reasoning');
  });

  it('reports a content filter as a content filter', () => {
    expect(explainEmptyReply({ finish_reason: 'content_filter' }, {}, 4000))
      .toContain('content filter');
  });

  it('reports a tool-call attempt', () => {
    const msg = explainEmptyReply(
      { finish_reason: 'tool_calls', message: { tool_calls: [{}] } }, {}, 4000);
    expect(msg).toContain('tool');
  });

  it('points at the model name when the provider returns no choices at all', () => {
    expect(explainEmptyReply(undefined, undefined, 4000)).toContain('model name');
  });

  it('still says something specific when nothing is recognisable', () => {
    const msg = explainEmptyReply({ finish_reason: 'stop', message: { content: '' } }, {}, 4000);
    expect(msg).toContain('empty answer');
    expect(msg).toContain('stop');
  });
});
