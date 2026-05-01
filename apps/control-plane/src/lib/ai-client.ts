/**
 * AI Client — advisory-only assistant for gate content.
 *
 * Multi-provider support: Ollama, OpenAI, Groq, Together.
 * AI may surface reality, but it may not supply intent.
 *
 * Ported from demo-deploy/apps/ui/src/local-ai/client.ts
 * Key difference: runs server-side, keys never sent to browser.
 */

export interface AIConfig {
  provider: 'ollama' | 'openai-compatible';
  endpoint: string;
  model: string;
  apiKey?: string;
}

export const PROVIDER_PRESETS: Record<string, AIConfig> = {
  ollama: {
    provider: 'ollama',
    endpoint: 'http://localhost:11434',
    model: 'gemma4:e4b',
  },
  openrouter: {
    provider: 'openai-compatible',
    endpoint: 'https://openrouter.ai/api/v1',
    model: 'google/gemma-4-31b-it',
  },
  openai: {
    provider: 'openai-compatible',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  groq: {
    provider: 'openai-compatible',
    endpoint: 'https://api.groq.com/openai/v1',
    model: 'llama-3.1-8b-instant',
  },
  together: {
    provider: 'openai-compatible',
    endpoint: 'https://api.together.xyz/v1',
    model: 'meta-llama/Llama-3-8b-chat-hf',
  },
};

export interface AIAssistRequest {
  gate: 'intent';
  currentText: string;
  context?: {
    profileId?: string;
    path?: string;
    bounds?: string;
    prTitle?: string;
    prBody?: string;
    prBranch?: string;
    prFileSummary?: string;
  };
}

export interface AIAssistResponse {
  success: boolean;
  suggestion?: string;
  error?: string;
  disclaimer: string;
}

const SYSTEM_PROMPTS: Record<string, string> = {
  intent: `You are a reviewing assistant helping a human articulate their intent for an AI agent authorization.

The user is granting an agent permission to act within defined bounds. They need to describe:
- Why this authorization exists (the situation)
- What the agent should try to achieve (the goal)
- What the agent should avoid or be careful about (watch-outs)

Your role:
- Surface risks or edge cases the user may not have considered
- Point out gaps — is anything important missing?
- Help the user think through what the agent needs to know

You must NOT:
- Write the intent for the user
- Make decisions about what the agent should do
- Propose specific wording

Keep responses to 2-3 short paragraphs. Be practical and specific to the context.`,
};

export async function getAIAssistance(
  config: AIConfig,
  request: AIAssistRequest,
): Promise<AIAssistResponse> {
  const disclaimer = 'AI surfaces reality. You supply intent.';

  const systemPrompt = SYSTEM_PROMPTS[request.gate] ?? SYSTEM_PROMPTS.intent;

  const contextParts: string[] = [];
  if (request.context?.profileId) contextParts.push(`Profile: ${request.context.profileId}`);
  if (request.context?.path) contextParts.push(`Path: ${request.context.path}`);
  if (request.context?.bounds) contextParts.push(`Bounds: ${request.context.bounds}`);
  if (request.context?.prTitle) contextParts.push(`PR Title: ${request.context.prTitle}`);
  if (request.context?.prBody) contextParts.push(`PR Description: ${request.context.prBody}`);
  if (request.context?.prBranch) contextParts.push(`Branch: ${request.context.prBranch}`);
  if (request.context?.prFileSummary) contextParts.push(`Changed Files:\n${request.context.prFileSummary}`);

  const userPrompt = [
    contextParts.length > 0 ? `Context:\n${contextParts.join('\n')}` : '',
    request.currentText
      ? `The reviewer has written:\n"${request.currentText}"`
      : 'The reviewer has not yet written anything.',
    `Help them think through the ${request.gate}.`,
  ].filter(Boolean).join('\n\n');

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userPrompt },
  ];

  try {
    let suggestion: string;

    if (config.provider === 'ollama') {
      const response = await fetch(`${config.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          messages,
          stream: false,
          options: { temperature: 0.1, num_predict: 300 },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Ollama: ${response.status}`);
      const data = await response.json() as { message?: { content?: string } };
      suggestion = data.message?.content?.trim() || 'No response generated.';
    } else {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

      const response = await fetch(`${config.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.1,
          max_tokens: 300,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AI provider: ${response.status} - ${errorText}`);
      }
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      suggestion = data.choices?.[0]?.message?.content?.trim() || 'No response generated.';
    }

    return { success: true, suggestion, disclaimer };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      disclaimer,
    };
  }
}

// ─── Multi-turn chat (Phase 3 of Agent Brief) ──────────────────────────────
//
// Extends the one-shot `getAIAssistance` above with conversational refinement
// of two documents: the agent brief's context.md, and a per-authorization
// Intent paragraph. Same provider plumbing; different system prompts and a
// message history instead of a single question.

export type ChatTarget =
  | { kind: 'context' }
  | { kind: 'intent'; profileId?: string; path?: string; bounds?: string };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIChatRequest {
  target: ChatTarget;
  currentText: string;
  messages: ChatMessage[];
}

export interface AIChatResponse {
  success: boolean;
  reply?: string;
  error?: string;
}

/** Default AI assistant system prompts.
 *  An override stored in ~/.hap/ai-prompts.json (via ai-prompts-store)
 *  wins per-kind when present. The defaults stay as the immutable
 *  fallback — deleting the override file reverts behavior. */
export const CHAT_SYSTEM_PROMPTS: Record<ChatTarget['kind'], string> = {
  context: `You help a human author "context.md" — the standing-orders brief that is prepended to every AI agent session under the Human Agency Protocol (HAP).

This text goes straight into the system prompt of downstream agents. Keep it operational, concrete, and short. Favor examples the user would recognize from their work.

Your role is to:
- Ask clarifying questions when the user's intent is unclear.
- Flag gaps or ambiguities that would confuse an agent.
- Propose concrete phrasings when the user asks for them.

When you propose a complete draft (or a full-document rewrite) of the context, wrap the draft in a fenced block like this:

\`\`\`markdown
...
\`\`\`

Only use that fence for full-document drafts the user can click "Apply". For partial suggestions, comments, or questions, write prose without the fence.`,

  intent: `You help a human write an "Intent" paragraph for an AI agent authorization under the Human Agency Protocol (HAP).

The Intent is read by two audiences:
1. The agent, on demand via list-authorizations(domain), when it's about to act in this domain.
2. Human reviewers, when the agent proposes an action that needs approval.

A good Intent can describe:
- Why this authorization exists (the situation).
- What the agent should try to achieve (the goal).
- Soft rules or watch-outs the agent must honor even inside bounds (e.g. "never publish on weekends", "only reply in German").

Your role is to coach: ask clarifying questions, reflect the user's words back, surface edge cases they haven't thought about. You may propose concrete phrasings on request.

CRITICAL — ask before you draft.

Before you produce ANY full-document draft (anything wrapped in a \`\`\`markdown fence), you MUST first ask the user which of the three things to cover:

  • Why — the situation that made them set this up
  • Goal — what the agent should try to achieve
  • Watch out — what the agent should avoid

Phrase the question briefly and let them pick any combination, "all three", or skip any they'd rather leave out. WAIT for their answer. Do not draft until they have answered. This rule is non-negotiable, even if the user's first message is "draft a full intent for X" — you still ask the clarifying question first, then draft on the next turn.

Once they have answered, produce the draft inside a single fenced block:

\`\`\`markdown
...
\`\`\`

Only use the fence for full-document drafts the user can click "Apply". For partial suggestions, questions, comments, or reflections, write prose without the fence.`,
};

export async function getAIChatResponse(
  config: AIConfig,
  request: AIChatRequest,
): Promise<AIChatResponse> {
  // Prefer a stored override from ~/.hap/ai-prompts.json; fall back to
  // the default constant. The store handles missing-file / empty-value
  // gracefully so this is safe to call on every turn.
  const { getPromptOverride } = await import('./ai-prompts-store');
  const override = await getPromptOverride(request.target.kind);
  const systemPrompt = override ?? CHAT_SYSTEM_PROMPTS[request.target.kind];

  // Build a grounding preamble so the model sees the current document and
  // any authorization context. This is injected as the first user turn so
  // it survives message-history truncation by the provider.
  const groundingParts: string[] = [];
  if (request.target.kind === 'intent') {
    if (request.target.profileId) groundingParts.push(`Profile: ${request.target.profileId}`);
    if (request.target.path) groundingParts.push(`Path: ${request.target.path}`);
    if (request.target.bounds) groundingParts.push(`Bounds: ${request.target.bounds}`);
  }
  groundingParts.push(
    request.currentText.trim()
      ? `Current draft:\n"""\n${request.currentText}\n"""`
      : 'Current draft is empty.',
  );
  const grounding = groundingParts.join('\n');

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: grounding },
    ...request.messages.map(m => ({ role: m.role, content: m.content })),
  ];

  try {
    let reply: string;

    if (config.provider === 'ollama') {
      const response = await fetch(`${config.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          messages,
          stream: false,
          options: { temperature: 0.3, num_predict: 600 },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Ollama: ${response.status}`);
      const data = await response.json() as { message?: { content?: string } };
      reply = data.message?.content?.trim() || 'No response generated.';
    } else {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

      const response = await fetch(`${config.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.3,
          max_tokens: 600,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AI provider: ${response.status} - ${errorText}`);
      }
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      reply = data.choices?.[0]?.message?.content?.trim() || 'No response generated.';
    }

    return { success: true, reply };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function testAIConnectivity(config: AIConfig): Promise<{ ok: boolean; message: string }> {
  try {
    if (config.provider === 'ollama') {
      const res = await fetch(`${config.endpoint}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`Ollama: ${res.status}`);
      return { ok: true, message: 'Ollama is reachable' };
    } else {
      const headers: Record<string, string> = {};
      if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
      const res = await fetch(`${config.endpoint}/models`, {
        headers,
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`AI provider: ${res.status}`);
      return { ok: true, message: 'AI provider is reachable' };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Connection failed' };
  }
}
