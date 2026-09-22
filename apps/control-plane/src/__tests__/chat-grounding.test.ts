import { describe, it, expect } from 'vitest';
import { buildChatGrounding } from '../lib/ai-client';

/**
 * The intent assistant used to see only profile, bounds and the draft — not
 * the Agent Brief the agent itself receives. So it could not answer "is this
 * already covered by my standing orders?" and happily drafted rules the brief
 * already had. These pin that the brief is grounded for `intent` and only there.
 */
describe('buildChatGrounding', () => {
  const brief = '# Agent Brief\n\n- Nothing to press without my explicit go.';

  it('includes the Agent Brief when grounding an intent chat', () => {
    const g = buildChatGrounding({ kind: 'intent', profileId: 'email@0.6' }, '', brief);
    expect(g).toContain('Profile: email@0.6');
    expect(g).toContain('Agent Brief');
    expect(g).toContain('Nothing to press without my explicit go.');
    expect(g).toContain('Current draft is empty.');
  });

  it('places the brief before the draft, so the draft reads as the newer layer', () => {
    const g = buildChatGrounding({ kind: 'intent' }, 'Reply to demo requests within a day.', brief);
    expect(g.indexOf('Agent Brief')).toBeLessThan(g.indexOf('Current draft:'));
    expect(g).toContain('Reply to demo requests within a day.');
  });

  it('omits the brief section when no brief has been written', () => {
    expect(buildChatGrounding({ kind: 'intent' }, '', '')).not.toContain('Agent Brief');
    expect(buildChatGrounding({ kind: 'intent' }, '', '   \n')).not.toContain('Agent Brief');
    expect(buildChatGrounding({ kind: 'intent' }, '', undefined)).not.toContain('Agent Brief');
  });

  it('never repeats the brief for the context chat — there it is the draft itself', () => {
    const g = buildChatGrounding({ kind: 'context' }, brief, brief);
    expect(g).not.toContain('standing orders every agent already receives');
    expect(g).toContain('Current draft:');
  });
});
