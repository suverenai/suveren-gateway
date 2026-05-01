/**
 * AI prompt overrides — view & edit the system prompts used by the
 * AI assistant on the Intent gate and Brief page.
 */

import { Router, type Request, type Response } from 'express';
import { CHAT_SYSTEM_PROMPTS } from '../lib/ai-client';
import {
  getAllPromptOverrides,
  setPromptOverride,
  type PromptKind,
} from '../lib/ai-prompts-store';

const KINDS: readonly PromptKind[] = ['intent', 'context'];

function isPromptKind(s: string): s is PromptKind {
  return (KINDS as readonly string[]).includes(s);
}

export function createAIPromptsRouter(): Router {
  const router = Router();

  /**
   * GET /ai/prompts
   * Returns both the current effective text and the immutable default
   * for each prompt kind so the UI can show "is this an override".
   */
  router.get('/', async (_req: Request, res: Response) => {
    const overrides = await getAllPromptOverrides();
    const out: Record<PromptKind, { current: string; default: string; overridden: boolean }> = {
      intent: {
        current: overrides.intent && overrides.intent.trim() ? overrides.intent : CHAT_SYSTEM_PROMPTS.intent,
        default: CHAT_SYSTEM_PROMPTS.intent,
        overridden: !!(overrides.intent && overrides.intent.trim()),
      },
      context: {
        current: overrides.context && overrides.context.trim() ? overrides.context : CHAT_SYSTEM_PROMPTS.context,
        default: CHAT_SYSTEM_PROMPTS.context,
        overridden: !!(overrides.context && overrides.context.trim()),
      },
    };
    res.json(out);
  });

  /**
   * PUT /ai/prompts/:kind
   * Body: { value: string }
   * An empty / whitespace value deletes the override (revert to default).
   */
  router.put('/:kind', async (req: Request, res: Response) => {
    const kind = String(req.params.kind ?? '');
    if (!isPromptKind(kind)) {
      res.status(400).json({ error: `Invalid prompt kind: ${kind}` });
      return;
    }
    const value = (req.body as { value?: string })?.value;
    if (typeof value !== 'string') {
      res.status(400).json({ error: 'Body must be { value: string }' });
      return;
    }
    await setPromptOverride(kind, value);
    res.json({ ok: true });
  });

  return router;
}
