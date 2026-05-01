/**
 * POST /api/approved-intents
 *
 * Persist an approver's decrypted intent as their local accountability record.
 * Intent is re-encrypted with the vault key before writing to disk.
 *
 * Body:
 *   { authorityId: string, intent: string }
 *
 * Storage:
 *   ~/.hap/approved-intents.enc.json  — map of authorityId → EncryptedBlob
 *
 * Auth: session must be active (requireAuth middleware applied by caller in index.ts).
 *
 * GET /api/approved-intents
 *   Returns all stored approved intents (decrypted). Used by the approver UI
 *   to avoid re-fetching and re-decrypting from the SP on every page load.
 */

import { Router, type Request, type Response } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Vault, EncryptedBlob } from '../lib/vault';

const HAP_DATA_DIR = process.env.HAP_DATA_DIR ?? join(homedir(), '.hap');
const FILE_PATH = join(HAP_DATA_DIR, 'approved-intents.enc.json');

interface ApprovedIntentsFile {
  version: 1;
  entries: Record<string, EncryptedBlob>;
}

function readFile(): ApprovedIntentsFile {
  if (!existsSync(FILE_PATH)) {
    return { version: 1, entries: {} };
  }
  try {
    return JSON.parse(readFileSync(FILE_PATH, 'utf-8')) as ApprovedIntentsFile;
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeFile(data: ApprovedIntentsFile): void {
  mkdirSync(HAP_DATA_DIR, { recursive: true });
  writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

export function createApprovedIntentsRouter(vault: Vault): Router {
  const router = Router();

  // GET /api/approved-intents — return all stored intents (decrypted plaintext)
  router.get('/', (req: Request, res: Response) => {
    try {
      const file = readFile();
      const result: Record<string, string> = {};
      for (const [authorityId, blob] of Object.entries(file.entries)) {
        try {
          result[authorityId] = vault.decrypt(blob);
        } catch {
          // If decryption fails (vault re-keyed), skip this entry silently.
        }
      }
      res.json({ intents: result });
    } catch (err) {
      console.error('[Control Plane] approved-intents GET error:', err);
      res.status(500).json({ error: 'Failed to read approved intents' });
    }
  });

  // POST /api/approved-intents — store a newly approved intent
  router.post('/', (req: Request, res: Response) => {
    const { authorityId, intent } = req.body as {
      authorityId?: unknown;
      intent?: unknown;
    };

    if (typeof authorityId !== 'string' || authorityId.length === 0) {
      res.status(400).json({ error: 'Missing or invalid field: authorityId (string)' });
      return;
    }

    if (typeof intent !== 'string' || intent.length === 0) {
      res.status(400).json({ error: 'Missing or invalid field: intent (string)' });
      return;
    }

    try {
      const blob = vault.encrypt(intent);
      const file = readFile();
      file.entries[authorityId] = blob;
      writeFile(file);
      res.json({ ok: true });
    } catch (err) {
      console.error('[Control Plane] approved-intents POST error:', err);
      res.status(500).json({ error: 'Failed to store approved intent' });
    }
  });

  return router;
}
