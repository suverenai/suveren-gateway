import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard: every mutating route that reads `req.body` must mount `jsonParser`.
 *
 * There is deliberately NO global `express.json()` in the control plane —
 * parsing consumes the request stream, which breaks the routes that need the
 * raw body — so each route opts in. Forget it and `req.body` is `undefined`;
 * the handler then throws on the first property access and Express answers
 * **500**, which reads like a server fault rather than a wiring mistake.
 *
 * This shipped once (PUT /integrations/:id/read-policy) and cost a live 500 in
 * the UI, so it is checked statically rather than left to per-route tests: the
 * mistake is invisible in review and identical every time.
 */
describe('control-plane routes — body parsing is wired', () => {
  const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8');

  /** Split index.ts into one block per app.post/put/patch registration. */
  function mutatingRoutes(): Array<{ method: string; path: string; head: string; block: string }> {
    const parts = src.split(/\napp\.(post|put|patch)\(/);
    const routes: Array<{ method: string; path: string; head: string; block: string }> = [];
    for (let i = 1; i < parts.length; i += 2) {
      const method = parts[i];
      const rest = parts[i + 1];
      // Up to the next top-level app.<verb>( registration.
      const block = rest.split(/\napp\.[a-z]+\(/)[0];
      // Middleware chain = everything before the handler's arrow.
      const head = block.split('=>')[0];
      const path = block.split(',')[0].trim();
      routes.push({ method, path, head, block });
    }
    return routes;
  }

  it('finds the mutating routes at all (guard against a broken matcher)', () => {
    // If index.ts is restructured so this parser matches nothing, the test
    // below would vacuously pass. Fail loudly instead.
    const routes = mutatingRoutes();
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.some(r => r.block.includes('req.body'))).toBe(true);
  });

  it('every route reading req.body mounts jsonParser', () => {
    const offenders = mutatingRoutes()
      .filter(r => r.block.includes('req.body'))
      .filter(r => !r.head.includes('jsonParser'))
      .map(r => `${r.method.toUpperCase()} ${r.path}`);

    expect(offenders, `these routes read req.body without jsonParser and will 500: ${offenders.join(', ')}`)
      .toEqual([]);
  });
});
