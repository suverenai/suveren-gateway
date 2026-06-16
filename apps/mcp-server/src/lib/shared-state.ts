/**
 * Shared State — singleton that lives at the HTTP server level, reused across MCP connections.
 *
 * Holds one SPClient, one AttestationCache, and one GateStore.
 */

import { SPClient } from './sp-client';
import { AttestationCache, type CachedAuthorization } from './attestation-cache';
import { GateStore, type GateContent, type GateEntry } from './gate-store';
import { ExecutionLog } from './execution-log';
import { MCPGatekeeper } from './gatekeeper';

export interface EnrichedAuthorization extends CachedAuthorization {
  gateContent: GateContent | null;
  // v0.4 fields merged from gate store (may override cache values)
  context?: Record<string, string | number>;
  contextHash?: string;
}

export class SharedState {
  readonly spClient: SPClient;
  readonly cache: AttestationCache;
  readonly gateStore: GateStore;
  readonly executionLog: ExecutionLog;
  readonly gatekeeper: MCPGatekeeper;

  constructor(spUrl: string, gateStorePath?: string) {
    this.spClient = new SPClient(spUrl);
    this.cache = new AttestationCache(this.spClient);
    this.gateStore = new GateStore(gateStorePath);
    this.executionLog = new ExecutionLog(gateStorePath);
    this.gatekeeper = new MCPGatekeeper(this.cache, this.executionLog);
  }

  setGateContent(
    path: string,
    frameHash: string,
    profileId: string,
    content: GateContent,
    opts?: {
      boundsHash?: string;
      contextHash?: string;
      context?: Record<string, string | number>;
    },
  ): void {
    this.gateStore.set(path, {
      frameHash,
      boundsHash: opts?.boundsHash,
      contextHash: opts?.contextHash,
      path,
      profileId,
      gateContent: content,
      context: opts?.context,
      storedAt: new Date().toISOString(),
    });
  }

  getGateContent(path: string): GateEntry | null {
    return this.gateStore.get(path);
  }

  /**
   * Join active+complete cached authorizations with gate content from the GateStore.
   * v0.4: also merges context/contextHash from gate store if not present on cached auth.
   */
  getEnrichedAuthorizations(): EnrichedAuthorization[] {
    const authorizations = this.cache.getAllAuthorizations();

    return authorizations
      .map(auth => {
        // Match gate content by the authorization's unique frameHash so two
        // grants under the same profile keep their own intent. boundsHash and
        // path are legacy (v0.3) fallbacks. The previous profileId-wide scan
        // was removed — it cross-contaminated intent between grants.
        const gateEntry =
          (auth.frameHash ? this.gateStore.get(auth.frameHash) : null) ??
          (auth.boundsHash ? this.gateStore.get(auth.boundsHash) : null) ??
          this.gateStore.get(auth.path) ??
          null;

        return {
          ...auth,
          gateContent: gateEntry?.gateContent ?? null,
          context: auth.context ?? gateEntry?.context,
          contextHash: auth.contextHash ?? gateEntry?.contextHash,
        };
      })
      .filter(auth => auth.gateContent !== null);
  }
}
