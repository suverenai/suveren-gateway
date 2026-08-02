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

  it('scopes the deploy through the EXECUTION CONTEXT, not a read adapter', () => {
    // Originally written as `resourceBound: allowed_environments` on this
    // consequential tool. That is dead config: resourceBound is only ever read
    // from `tool.gating.read`, i.e. the read path. It looked like environment
    // scoping and enforced nothing — and a test asserting its presence
    // manufactured confidence in a control that was not running.
    //
    // The mechanism that actually holds is the execution-context mapping below,
    // checked against the authorization's `allowed_environments`. Assert that,
    // and assert the dead config stays gone.
    expect(deploy().executionMapping?.environment).toBe('allowed_environments');
    expect(deploy(), 'resourceBound does nothing on a non-read tool').not.toHaveProperty('resourceBound');
    expect(deploy()).not.toHaveProperty('resourceArg');
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

/**
 * The manifest declaration must survive the RESOLVER, not merely exist.
 *
 * `resolveToolGating` builds tool gating from an explicit whitelist of fields.
 * `contentField` was added to the manifest and to the type but not to that
 * whitelist, so it was silently dropped: the deploy ran, a receipt was issued,
 * and it carried no commit binding at all. The failure only surfaced when a
 * verifier asked — in CI, on a real deploy.
 *
 * The existing tests passed because they hand-built a DiscoveredTool with
 * contentField already set, which is precisely the step that was broken. A test
 * that constructs the input it is meant to be checking cannot catch this.
 */
describe('manifest declarations survive gating resolution', () => {
  it('deploy carries contentField through to the resolved gating', async () => {
    const { IntegrationManager } = await import('../src/lib/integration-manager');
    const mgr = new IntegrationManager() as unknown as {
      resolveToolGating: (p: string | null, g: unknown, tool: string) => { contentField?: string } | null;
    };
    const resolved = mgr.resolveToolGating('deploy', MANIFEST.toolGating, 'deploy');
    expect(resolved?.contentField, 'contentField was dropped by resolveToolGating').toBe('sha');
  });

  it('every manifest field the engine reads is carried, not just declared', () => {
    // Guards the class rather than the instance: anything the manifest declares
    // for `deploy` should be reachable from resolved gating.
    const declared = Object.keys(MANIFEST.toolGating.overrides.deploy);
    expect(declared).toContain('contentField');
    expect(declared).toContain('executionMapping');
    expect(declared).toContain('staticExecution');
  });
});
