/**
 * AI routes — advisory-only AI assistant for gate content.
 *
 * All routes protected by requireAuth (applied in index.ts).
 * AI API key is decrypted from vault server-side — never sent to browser.
 */

import { Router, type Request, type Response } from 'express';
import type { Vault } from '../lib/vault';
import {
  getAIAssistance,
  getAIChatResponse,
  getIntentReview,
  testAIConnectivity,
  PROVIDER_PRESETS,
  type AIConfig,
  type AIAssistRequest,
  type AIChatRequest,
} from '../lib/ai-client';
import { getEnrichedAuthorizations } from '../lib/mcp-bridge';

interface EnrichedAuth {
  profileId: string;
  bounds: Record<string, string | number>;
  context: Record<string, string | number>;
  intent: string | null;
}

const describeScope = (c: Record<string, string | number> = {}): string => {
  const vals = Object.values(c).map(v => String(v).trim()).filter(Boolean);
  return vals.length > 0 ? vals.join(', ') : 'all (unscoped)';
};

export function createAIRouter(vault: Vault): Router {
  const router = Router();

  /** Load AI config from vault, returning null if not configured. */
  function loadAIConfig(): AIConfig | null {
    const cred = vault.getCredential('ai-config');
    if (!cred) return null;
    return {
      provider: (cred.provider as AIConfig['provider']) || 'ollama',
      endpoint: cred.endpoint || 'http://localhost:11434',
      model: cred.model || 'llama3.2',
      apiKey: cred.apiKey || undefined,
    };
  }

  /**
   * POST /ai/assist
   * Body: { gate, currentText, context? }
   */
  router.post('/assist', async (req: Request, res: Response) => {
    const config = loadAIConfig();
    if (!config) {
      res.status(400).json({ error: 'AI not configured. Save AI settings in Settings > General.' });
      return;
    }

    const request = req.body as AIAssistRequest;
    if (!request.gate) {
      res.status(400).json({ error: 'Missing gate field (intent)' });
      return;
    }

    const result = await getAIAssistance(config, request);
    res.json(result);
  });

  /**
   * POST /ai/chat — multi-turn refinement of context.md or a per-auth intent.
   * Body: { target, currentText, messages }
   */
  router.post('/chat', async (req: Request, res: Response) => {
    const config = loadAIConfig();
    if (!config) {
      res.status(400).json({ error: 'AI not configured. Save AI settings in Settings.' });
      return;
    }

    const request = req.body as AIChatRequest;
    if (!request.target || !request.target.kind) {
      res.status(400).json({ error: 'Missing target.kind (context | intent)' });
      return;
    }
    if (!Array.isArray(request.messages)) {
      res.status(400).json({ error: 'Missing messages array' });
      return;
    }

    const result = await getAIChatResponse(config, request);
    res.json(result);
  });

  /**
   * POST /ai/intent-review — on-demand semantic cross-check of a new grant's
   * intent against existing grants on the same profile. Existing intents are
   * fetched server-side (never round-tripped through the browser).
   * Body: { profileId, newIntent, bounds?, context? }
   */
  router.post('/intent-review', async (req: Request, res: Response) => {
    const config = loadAIConfig();
    if (!config) {
      res.status(400).json({ error: 'AI not configured. Save AI settings in Settings > General.' });
      return;
    }

    const { profileId, newIntent, context } = req.body as {
      profileId?: string;
      newIntent?: string;
      context?: Record<string, string | number>;
    };
    if (!profileId) {
      res.status(400).json({ error: 'Missing profileId' });
      return;
    }

    let existing: EnrichedAuth[] = [];
    try {
      const data = await getEnrichedAuthorizations() as { authorizations?: EnrichedAuth[] };
      existing = (data.authorizations ?? []).filter(a => a.profileId === profileId && !!a.intent?.trim());
    } catch {
      existing = [];
    }

    if (existing.length === 0) {
      res.json({ success: true, review: null, note: 'No other authorizations on this profile to compare against.' });
      return;
    }

    const result = await getIntentReview(config, {
      profileName: profileId.split('/').pop() ?? profileId,
      newIntent: newIntent ?? '',
      scope: describeScope(context),
      existingGrants: existing.map(a => ({
        intent: a.intent ?? '',
        scope: describeScope(a.context),
      })),
    });
    // Include the structured grants the advisory refers to, so the UI can make
    // the scope mentions clickable and show real content (not parsed from the LLM).
    res.json({
      ...result,
      grants: existing.map(a => ({
        scope: describeScope(a.context),
        intent: a.intent,
        bounds: a.bounds,
      })),
    });
  });

  /**
   * POST /ai/test
   * Body: optional { provider, endpoint, model, apiKey } — if absent, uses stored config.
   */
  router.post('/test', async (req: Request, res: Response) => {
    const body = req.body as Partial<AIConfig> | undefined;

    let config: AIConfig;
    if (body?.endpoint) {
      config = {
        provider: body.provider || 'ollama',
        endpoint: body.endpoint,
        model: body.model || '',
        apiKey: body.apiKey,
      };
    } else {
      const stored = loadAIConfig();
      if (!stored) {
        res.status(400).json({ ok: false, message: 'No AI config stored' });
        return;
      }
      config = stored;
    }

    const result = await testAIConnectivity(config);
    res.json(result);
  });

  /**
   * GET /ai/presets
   */
  router.get('/presets', (_req: Request, res: Response) => {
    res.json({ presets: PROVIDER_PRESETS });
  });

  return router;
}
