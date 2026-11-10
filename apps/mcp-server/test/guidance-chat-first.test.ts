import { describe, it, expect } from 'vitest';
import { AGENT_RULES } from '../src/lib/agent-rules';
import { factsLines, firstMandateText } from '../src/lib/guidance';

describe('the person works from the chat; the gateway page is theirs', () => {
  const rules = AGENT_RULES.join('\n');

  it('forbids showing the gateway page as a link or preview, or offering to open it', () => {
    expect(rules).toMatch(/not in a preview or built-in browser inside this chat/);
    expect(rules).toMatch(/Never show it as a clickable link, a web preview or an open button, and never offer to open it/);
    expect(rules).toMatch(/in their own browser, outside this chat: give the address only as plain code text/);
  });

  it('says why the Setup mandate exists: mandates are managed from this chat', () => {
    const facts = factsLines({ card: 'Vollmacht', areas: [] }).join('\n');
    expect(facts).toContain('The Vollmacht mandate is how the person manages their mandates from this chat.');
    expect(facts).toContain('they only approve it');
    expect(firstMandateText({ url: 'http://x', card: 'Vollmacht' })).toContain('from then on they manage their mandates from this chat');
  });
});
