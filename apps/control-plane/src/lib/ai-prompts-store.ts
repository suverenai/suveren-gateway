import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Persistent override for the AI assistant system prompts.
 *
 * Plain JSON file at `${HAP_DATA_DIR}/ai-prompts.json`. Missing file or
 * missing key → fall through to the default constant in ai-client.ts.
 * Empty string ("") in a key is treated as "no override" so the
 * Settings UI can revert to default by saving an empty value.
 */

export type PromptKind = 'intent' | 'context';

interface AIPromptsFile {
  intent?: string;
  context?: string;
}

function dataDir(): string {
  return process.env.HAP_DATA_DIR ?? join(homedir(), '.hap');
}

function filePath(): string {
  return join(dataDir(), 'ai-prompts.json');
}

let cache: AIPromptsFile | null = null;
let cacheLoaded = false;

async function load(): Promise<AIPromptsFile> {
  if (cacheLoaded && cache) return cache;
  try {
    const raw = await fs.readFile(filePath(), 'utf8');
    cache = JSON.parse(raw) as AIPromptsFile;
  } catch {
    cache = {};
  }
  cacheLoaded = true;
  return cache;
}

/** Return the override for a given prompt kind, or null if none / empty. */
export async function getPromptOverride(kind: PromptKind): Promise<string | null> {
  const file = await load();
  const value = file[kind];
  return value && value.trim().length > 0 ? value : null;
}

/** Return the full override file (used by the Settings UI). */
export async function getAllPromptOverrides(): Promise<AIPromptsFile> {
  return { ...(await load()) };
}

/** Persist an override. Empty / whitespace string deletes the key. */
export async function setPromptOverride(kind: PromptKind, value: string): Promise<void> {
  const file = await load();
  if (value && value.trim().length > 0) {
    file[kind] = value;
  } else {
    delete file[kind];
  }
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(filePath(), JSON.stringify(file, null, 2), 'utf8');
  cache = { ...file };
  cacheLoaded = true;
}

/** Drop the in-memory cache so the next load reads from disk. Test-only. */
export function _resetCacheForTests(): void {
  cache = null;
  cacheLoaded = false;
}
