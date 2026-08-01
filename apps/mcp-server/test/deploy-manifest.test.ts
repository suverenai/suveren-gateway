import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The deploy manifest carries decisions that fail SILENTLY when wrong — the
 * gateway would keep working and simply stop enforcing something. Each case
 * here is one of those.
 */
const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'integrations', 'deploy-github.json'), 'utf-8'),
) as {
  profile: string;
  credentials: { fields: Array<{ key: string }>; envMapping: Record<string, string> };
  toolGating: {
    default: { category?: string };
    overrides: Record<string, Record<string, unknown>>;
  };
  templates: Array<{ name: string; mode: string; bounds: Record<string, string>; context: Record<string, string> }>;
};

const deploy = () => MANIFEST.toolGating.overrides.deploy as {
  category?: string;
  staticExecution?: Record<string, string>;
  executionMapping?: Record<string, string>;
  resourceBound?: string;
  resourceArg?: string;
};

describe('deploy-github manifest', () => {
  it('binds to the deploy profile', () => {
    expect(MANIFEST.profile).toBe('deploy');
  });

  it('undeclared tools are DISABLED, not merely ungated', () => {
    // The connector may grow tools faster than this manifest does. A permissive
    // default would expose a future tool the moment it ships — gated by
    // whatever the default happens to say, which nobody chose for it.
    expect(MANIFEST.toolGating.default.category).toBe('disabled');
  });

  it('deploy is consequential — never categorised as a read', () => {
    // A read never requests a receipt. Mislabelling deploy would remove the
    // entire authority check while leaving the tool working.
    expect(deploy().category).not.toBe('read');
    expect(deploy().staticExecution?.action_type).toBe('deploy');
  });

  it('action_type is STATIC, never taken from an agent argument', () => {
    // If the agent could supply action_type it could present a deploy as
    // something cheaper and be measured against the wrong limits.
    expect(deploy().staticExecution).toHaveProperty('action_type');
    expect(Object.values(deploy().executionMapping ?? {})).not.toContain('action_type');
  });

  it('maps repo, environment and workflow into the execution context', () => {
    // These reach the receipt. Without them the receipt proves a deploy was
    // authorised without saying WHAT was deployed or WHERE — most of what a
    // reader of the receipt actually wants.
    expect(deploy().executionMapping).toEqual({
      repo: 'allowed_repos',
      environment: 'allowed_environments',
      workflow: 'allowed_workflows',
    });
  });

  it('scopes the deploy to permitted environments', () => {
    expect(deploy().resourceBound).toBe('allowed_environments');
    expect(deploy().resourceArg).toBe('environment');
  });

  it('scopes every read tool to permitted repositories', () => {
    for (const [name, cfg] of Object.entries(MANIFEST.toolGating.overrides)) {
      if ((cfg as { category?: string }).category !== 'read') continue;
      const read = (cfg as { read?: { resourceBound?: string } }).read;
      expect(read?.resourceBound, `${name} must be scoped to allowed_repos`).toBe('allowed_repos');
    }
  });

  it('takes the token from the environment, never as a tool argument', () => {
    expect(MANIFEST.credentials.envMapping).toEqual({ GITHUB_TOKEN: 'githubToken' });
  });

  it('the read-only template really cannot deploy', () => {
    // Zero is a real limit. If this ever became "" or absent, the template
    // would stop bounding anything and the reads-only promise would be false.
    const watch = MANIFEST.templates.find(t => t.name === 'Watch deploys')!;
    expect(watch.bounds.deploy_daily_max).toBe('0');
    expect(watch.bounds.rollback_allowed).toBe('no');
  });

  it('the production template waits for a human', () => {
    const prod = MANIFEST.templates.find(t => t.name === 'Deploy production, review')!;
    expect(prod.mode).toBe('review');
    expect(Number(prod.bounds.deploy_daily_max)).toBeGreaterThan(0);
    expect(prod.context.allowed_workflows).toBeTruthy();
  });

  it('no template ships a wildcard scope', () => {
    // An empty string means "fill this in" and denies until you do. A "*" would
    // mean the opposite, and would look almost identical in review.
    for (const t of MANIFEST.templates) {
      for (const [k, v] of Object.entries(t.context)) {
        expect(v, `${t.name}.${k} must not be a wildcard`).not.toBe('*');
      }
    }
  });
});
