/**
 * SP API Client for Platform UI
 *
 * All requests go through the control-plane, which proxies /api/* to the SP.
 * Authentication is API-key-based (X-API-Key header on every request).
 * No cookies are used — the API key is stored in React state only.
 */

export interface SPUser {
  id: string;
  name: string;
  email: string;
  did: string;
}

export interface SPGroup {
  id: string;
  name: string;
  myDomains: string[];
  isAdmin: boolean;
  /** v0.4: true for the auto-provisioned single-member personal workspace. */
  isPersonal?: boolean;
}

export interface GroupMember {
  groupId: string;
  userId: string;
  domains: string[];
  joinedAt: number;
  role: string;
  status?: 'active' | 'disabled';
  disabledAt?: number;
  disabledBy?: string;
}

export interface AttestResponse {
  attestation_id: string;
  frame_hash?: string;    // v0.3
  bounds_hash?: string;   // v0.4
  context_hash?: string;  // v0.4
  domain: string;
  blob: string;
  expires_at: number;
  status: 'active' | 'pending';
  attested_domains: string[];
  required_domains: string[];
}

export interface ProfileSummary {
  id: string;
  name?: string;
  version: string;
  description: string;
  paths: string[];
}

export interface PendingItem {
  frame_hash: string;
  profile_id: string;
  path: string;
  title: string | null;
  sp_status: string | null;
  frame: Record<string, string | number>;
  required_domains: string[];
  attested_domains: string[];
  missing_domains: string[];
  deferred_commitment_domains: string[];
  created_at: string;
  earliest_expiry: string | null;
  remaining_seconds: number | null;
  /** Phase 6: frozen approver list at authority creation time. */
  approvers_frozen: string[];
  /** Phase 6: true when authority was created above a team cap. */
  above_cap: boolean;
}

export interface AttestationsResult {
  frame_hash: string;
  attestations: Array<{ domain: string; blob: string; expires_at: number }>;
  complete: boolean;
  frame?: Record<string, string | number>;
  profile_id?: string;
  path?: string;
  required_domains?: string[];
  attested_domains?: string[];
}

export interface VaultStatus {
  initialized: boolean;
  credentialNames: string[];
  serviceCount: number;
}

export interface AuthTemplate {
  name: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
  mode: 'automatic' | 'review';
  bounds: Record<string, string>;
  context: Record<string, string>;
  intent: string;
  ttl: number;
  tags: string[];
}

export interface IntegrationManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  icon: string;
  profile: string;
  mcp: { command: string; args: string[]; env?: Record<string, string> };
  credentials: {
    fields: Array<{ key: string; label: string; type: 'text' | 'password'; placeholder?: string; optional?: boolean }>;
    envMapping: Record<string, string>;
  };
  oauth: {
    authUrl: string;
    tokenUrl: string;
    scopes: string[];
    credentialKeys: Record<string, string>;
    tokenStorage: string;
    extraParams?: Record<string, string>;
  } | null;
  toolGating: unknown;
  templates?: AuthTemplate[];
  setupHint?: string;
  setupGuide?: Array<{ title: string; description: string; link?: string }>;
  /** Declares which context-scope fields can be discovered from the target service (wizard-only). */
  contextDiscovery?: Record<string, {
    baseUrl: string;
    endpoint: string;
    auth: 'bearer';
    credential?: string;
    responsePath: string;
    valueField: string;
    labelField: string;
    extraFields?: Record<string, string>;
  }>;
}

export interface McpIntegrationStatus {
  id: string;
  name: string;
  running: boolean;
  toolCount: number;
  error?: string;
}

export interface GateContentEntry {
  frameHash: string;
  boundsHash?: string;
  contextHash?: string;
  path: string;
  profileId: string;
  gateContent: { intent: string };
  context?: Record<string, string | number>;
  storedAt: string;
}

/** An active authorization enriched with its local context (scope). */
export interface EnrichedAuthorizationEntry {
  profileId: string;
  frameHash: string;
  bounds: Record<string, string | number>;
  context: Record<string, string | number>;
  intent: string | null;
  deferredCommitmentDomains: string[];
}

export interface Proposal {
  id: string;
  frameHash: string;
  profileId: string;
  path: string;
  pendingDomains: string[];
  committedBy: Record<string, { userId: string; at: number }>;
  rejectedBy: { domain: string; userId: string; at: number } | null;
  tool: string;
  toolArgs: Record<string, unknown>;
  executionContext: Record<string, string | number>;
  status: 'pending' | 'committed' | 'rejected' | 'expired' | 'executed';
  executionResult: unknown | null;
  createdAt: number;
  expiresAt: number;
  // Phase 6 fields
  pendingApprovers?: string[];
  approvedBy?: Record<string, { receiptId: string; at: number }>;
  approverRejectedBy?: { userId: string; reason?: string; at: number };
  createdBy?: string;
}

export interface ExecutionReceipt {
  id: string;
  groupId: string;
  userId: string;
  attestationHash: string;
  profileId: string;
  path: string;
  action: string;
  executionContext: Record<string, unknown>;
  cumulativeState: {
    daily: { amount: number; count: number };
    monthly: { amount: number; count: number };
  };
  timestamp: number;
  signature: string;
  /** Present only on receipts produced via a committed proposal (review mode). */
  proposalId?: string;
}

/** A window of receipts plus a cursor for loading the next (older) window. */
export interface ReceiptPage {
  receipts: ExecutionReceipt[];
  /** Pass back as `before` to load older receipts; null when none remain. */
  nextBefore: string | null;
}

/**
 * Per-profile team configuration (admin-set).
 * Mirrors suveren-as/src/lib/profile-config-store.ts — do not import from there.
 */
export interface DifferentAccountSummary {
  credentialCount: number;
  serviceCount: number;
  credentialIds: string[];
}

/**
 * Thrown by spClient.login() when the new API key would wipe an existing
 * vault that belongs to a different user. The caller is expected to confirm
 * via UI and retry login with `{ confirmWipe: true }`.
 */
export class DifferentAccountError extends Error {
  readonly summary: DifferentAccountSummary;
  constructor(summary: DifferentAccountSummary) {
    super('different_account');
    this.name = 'DifferentAccountError';
    this.summary = summary;
  }
}

export interface ProfileConfig {
  /** userIds of required approvers for above-cap actions */
  approvers: string[];
  /** Optional per-bound ceiling. Key = bound field name, value = max allowed. */
  caps?: Record<string, number>;
}

export interface McpHealthResponse {
  status: string;
  transports: string[];
  sp: string;
  activeSessions: number;
  storedGates: number;
  serviceCredentials: string[];
  integrations: McpIntegrationStatus[];
}

class SPClient {
  private apiKey: string | null = null;

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  clearApiKey(): void {
    this.apiKey = null;
  }

  /**
   * Used by EventSource (which can't send custom headers) to authenticate the
   * /events stream via a query-string token. Returns null if not logged in.
   */
  getApiKey(): string | null {
    return this.apiKey;
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
        ...init?.headers,
      },
    });
  }

  // ─── Auth ─────────────────────────────────────────────────────────────

  /**
   * Custom error for the "logging in with a different API key would wipe
   * the local vault" case. The UI catches this and shows a confirmation
   * modal listing the consequences before retrying with confirmWipe: true.
   */
  // (defined at module scope below — re-exported)

  async login(apiKey: string, opts: { confirmWipe?: boolean } = {}): Promise<SPUser> {
    const res = await this.fetch('/auth/login', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmWipe: opts.confirmWipe === true }),
    });
    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      if (data?.wouldWipe) {
        throw new DifferentAccountError(data.summary ?? { credentialCount: 0, serviceCount: 0, credentialIds: [] });
      }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Invalid API key' }));
      throw new Error(err.error || `Login failed: ${res.status}`);
    }
    const data = await res.json();
    return data.user;
  }

  async logout(): Promise<void> {
    await this.fetch('/auth/logout', { method: 'POST' });
  }

  // ─── SP proxy ─────────────────────────────────────────────────────────

  async getGroups(): Promise<SPGroup[]> {
    const res = await this.fetch('/api/groups');
    if (!res.ok) throw new Error(`Failed to fetch groups: ${res.status}`);
    const data = await res.json();
    return data.groups ?? data;
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    const res = await this.fetch('/api/profiles');
    if (!res.ok) throw new Error(`Failed to fetch profiles: ${res.status}`);
    const data = await res.json();
    return data.profiles;
  }

  async getProfile(id: string) {
    const res = await this.fetch(`/api/profiles/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Failed to fetch profile: ${res.status}`);
    return res.json();
  }

  async attest(body: {
    profile_id: string;
    // v0.3
    frame?: Record<string, string | number>;
    path?: string;
    // v0.4
    bounds?: Record<string, string | number>;
    bounds_hash?: string;
    context_hash?: string;
    // common
    domain: string;
    did: string;
    gate_content_hashes: Record<string, string>;
    execution_context_hash: string;
    group_id: string;
    ttl?: number;
    commitment_mode: 'automatic' | 'review';
    title?: string;
    // Phase 5 — E2EE intent (all optional; if any present, all three required)
    intent_ciphertext?: string;
    encrypted_keys?: Record<string, { ct: string; enc: string }>;
    approvers_frozen?: string[];
  }): Promise<AttestResponse> {
    const res = await this.fetch('/api/as/attest', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(err.error || `Attest failed: ${res.status}`);
    }
    return res.json();
  }

  async getPending(domain: string): Promise<PendingItem[]> {
    const res = await this.fetch(`/api/attestations/pending?domain=${encodeURIComponent(domain)}`);
    if (!res.ok) throw new Error(`Failed to fetch pending: ${res.status}`);
    const data = await res.json();
    return data.pending ?? data;
  }

  async getMyAttestations(status?: string): Promise<PendingItem[]> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await this.fetch(`/api/attestations/mine${qs}`);
    if (!res.ok) throw new Error(`Failed to fetch attestations: ${res.status}`);
    const data = await res.json();
    // Normalize mine response to PendingItem shape
    return (data.attestations ?? []).map((a: Record<string, unknown>) => ({
      // frameHash is the SP storage key (per-user scoped in v0.4 post-b228e58).
      // boundsHash is the content fingerprint and may collide across users.
      // Always use frameHash for read-by-hash lookups (revoke, intent, extend).
      frame_hash: a.frameHash ?? a.boundsHash,
      profile_id: a.profileId,
      path: a.path,
      title: a.title ?? null,
      sp_status: (a.status as string) ?? null,
      frame: a.bounds ?? a.frame ?? {},
      required_domains: a.requiredDomains ?? [],
      attested_domains: a.attestedDomains ?? [],
      missing_domains: (a.requiredDomains as string[] ?? []).filter(
        (d: string) => !(a.attestedDomains as string[] ?? []).includes(d)
      ),
      deferred_commitment_domains: a.deferredCommitmentDomains ?? [],
      approvers_frozen: (a.approversFrozen as string[]) ?? [],
      above_cap: (a.aboveCap as boolean) ?? false,
      created_at: a.createdAt ? new Date((a.createdAt as number) * 1000).toISOString() : '',
      earliest_expiry: (a.attestations as Array<{expiresAt: number}> | undefined)?.length
        ? new Date(Math.min(...(a.attestations as Array<{expiresAt: number}>).map(att => att.expiresAt)) * 1000).toISOString()
        : null,
      remaining_seconds: (a.attestations as Array<{expiresAt: number}> | undefined)?.length
        ? Math.max(0, Math.min(...(a.attestations as Array<{expiresAt: number}>).map(att => att.expiresAt)) - Math.floor(Date.now() / 1000))
        : null,
    }));
  }

  async getMyReceipts(options?: { date?: string; profile?: string; limit?: number }): Promise<ExecutionReceipt[]> {
    const params = new URLSearchParams();
    if (options?.date) params.set('date', options.date);
    if (options?.profile) params.set('profile', options.profile);
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    const res = await this.fetch(`/api/receipts/mine${qs ? '?' + qs : ''}`);
    if (!res.ok) throw new Error(`Failed to fetch receipts: ${res.status}`);
    const data = await res.json();
    return data.receipts ?? [];
  }

  async revokeAttestation(frameHash: string, reason?: string): Promise<void> {
    const res = await this.fetch(`/api/attestations/${encodeURIComponent(frameHash)}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason ?? 'Revoked by user' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to revoke' }));
      throw new Error(err.error || `Revoke failed: ${res.status}`);
    }
  }

  async getAttestations(frameHash: string): Promise<AttestationsResult> {
    const res = await this.fetch(`/api/attestations?frame_hash=${encodeURIComponent(frameHash)}`);
    if (!res.ok) throw new Error(`Failed to fetch attestations: ${res.status}`);
    return res.json();
  }

  async getGroupById(id: string): Promise<{ id: string; name: string; members: Array<{ id: string; name: string; email: string; domains: string[]; role: string }>; inviteCode?: string }> {
    const res = await this.fetch(`/api/groups/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Failed to fetch group: ${res.status}`);
    return res.json();
  }

  async createGroup(name: string): Promise<SPGroup> {
    const res = await this.fetch('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(err.error || `Create group failed: ${res.status}`);
    }
    const data = await res.json();
    const g = data.group || data;
    return { id: g.id, name: g.name, myDomains: g.myDomains || [], isAdmin: true };
  }

  async joinGroup(inviteCode: string): Promise<SPGroup> {
    const res = await this.fetch('/api/groups/join', {
      method: 'POST',
      body: JSON.stringify({ inviteCode }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(err.error || `Join group failed: ${res.status}`);
    }
    const data = await res.json();
    const g = data.group || data;
    return { id: g.id, name: g.name, myDomains: g.myDomains || [], isAdmin: g.isAdmin || false };
  }

  async inviteToGroup(groupId: string): Promise<{ inviteCode?: string; code?: string }> {
    const res = await this.fetch(`/api/groups/${encodeURIComponent(groupId)}/invite`, {
      method: 'POST',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(err.error || `Invite failed: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Returns the caller's active team group + membership, or null for personal-only users.
   * SP endpoint: GET /api/groups/me (Phase 1 addition).
   */
  async getMyTeam(): Promise<{ group: SPGroup; membership: GroupMember } | null> {
    const res = await this.fetch('/api/groups/me');
    if (!res.ok) return null;
    const data = await res.json();
    return data.group ? { group: data.group, membership: data.membership } : null;
  }

  /**
   * List all users known to the SP. Used to resolve approver display names
   * when the per-group members endpoint isn't enriched. Returns minimal
   * profile info ({ id, name, email, did }).
   */
  async listUsers(): Promise<Array<{ id: string; name: string; email: string; did?: string }>> {
    const res = await this.fetch('/api/users');
    if (!res.ok) return [];
    const data = await res.json();
    return data.users ?? [];
  }

  async setPubkey(pubkey: string): Promise<void> {
    const res = await this.fetch('/api/users/me/pubkey', {
      method: 'PUT',
      body: JSON.stringify({ pubkey }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to set pubkey' }));
      throw new Error(err.error || `setPubkey failed: ${res.status}`);
    }
  }

  async getPubkey(userId: string): Promise<string | null> {
    const res = await this.fetch(`/api/users/${encodeURIComponent(userId)}/pubkey`);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = await res.json();
    return data.pubkey ?? null;
  }

  async leaveTeam(groupId: string): Promise<void> {
    const res = await this.fetch(`/api/groups/${encodeURIComponent(groupId)}/leave`, {
      method: 'POST',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to leave team' }));
      throw new Error(err.error || `Leave failed: ${res.status}`);
    }
  }

  // ─── Vault ────────────────────────────────────────────────────────────

  async getVaultStatus(): Promise<VaultStatus> {
    const res = await this.fetch('/vault/status');
    if (!res.ok) throw new Error(`Failed to fetch vault status: ${res.status}`);
    return res.json();
  }

  async getCredential(name: string): Promise<{ configured: boolean; fieldNames?: string[]; fields?: Record<string, string> }> {
    const res = await this.fetch(`/vault/credentials/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`Failed to check credential: ${res.status}`);
    return res.json();
  }

  async setCredential(name: string, fields: Record<string, string>): Promise<void> {
    const res = await this.fetch(`/vault/credentials/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(fields),
    });
    if (!res.ok) throw new Error(`Failed to save credential: ${res.status}`);
  }

  async testCredential(name: string): Promise<{ ok: boolean; message: string }> {
    const res = await this.fetch(`/vault/test/${encodeURIComponent(name)}`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`Test failed: ${res.status}`);
    return res.json();
  }

  // ─── AI ───────────────────────────────────────────────────────────────

  async aiAssist(request: {
    gate: 'intent';
    currentText: string;
    context?: { profileId?: string; bounds?: string };
  }): Promise<{ success: boolean; suggestion?: string; error?: string; disclaimer: string }> {
    const res = await this.fetch('/ai/assist', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'AI request failed' }));
      return { success: false, error: err.error, disclaimer: 'AI surfaces reality. You supply intent.' };
    }
    return res.json();
  }

  async aiTest(config?: { provider?: string; endpoint?: string; model?: string; apiKey?: string }): Promise<{ ok: boolean; message: string }> {
    const res = await this.fetch('/ai/test', {
      method: 'POST',
      body: JSON.stringify(config ?? {}),
    });
    if (!res.ok) throw new Error(`AI test failed: ${res.status}`);
    return res.json();
  }

  // ─── MCP Integrations ──────────────────────────────────────────────────

  async getMcpHealth(): Promise<McpHealthResponse> {
    const res = await this.fetch('/mcp/health');
    if (!res.ok) throw new Error(`MCP server unreachable: ${res.status}`);
    return res.json();
  }

  async getMcpIntegrations(): Promise<{ integrations: McpIntegrationStatus[] }> {
    const res = await this.fetch('/mcp/integrations');
    if (!res.ok) throw new Error(`Failed to fetch integrations: ${res.status}`);
    return res.json();
  }

  /**
   * Auth-health probe: attempts a real token refresh server-side so the UI can
   * show whether the integration can actually authenticate (vs. just "a token
   * exists"). `failed` = the provider rejected the token (e.g. invalid_grant).
   */
  async getOAuthHealth(integrationId: string): Promise<{
    status: 'ok' | 'failed' | 'not_connected' | 'not_configured' | 'unverified';
    error?: string;
    account?: string;
  }> {
    try {
      const res = await this.fetch(`/auth/oauth/${encodeURIComponent(integrationId)}/health`);
      if (!res.ok) return { status: 'unverified' };
      return await res.json();
    } catch {
      return { status: 'unverified' };
    }
  }

  async getIntegrationManifests(): Promise<{ manifests: IntegrationManifest[] }> {
    const res = await this.fetch('/mcp/integrations/manifests');
    if (!res.ok) throw new Error(`Failed to fetch manifests: ${res.status}`);
    return res.json();
  }

  /**
   * Wizard-only scope-field discovery. Asks the control plane to fetch a
   * context-field's valid values from the connected service (e.g., Google
   * Calendar's calendarList). Returns normalized options for a multi-select.
   * See doc/hap-scope-discovery-proposal.md.
   */
  async discoverScopeField(integrationId: string, field: string): Promise<{
    options: Array<{ value: string; label: string; extras?: Record<string, unknown> }>;
  }> {
    const res = await this.fetch(
      `/integrations/${encodeURIComponent(integrationId)}/discover/${encodeURIComponent(field)}`,
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Discovery failed: ${res.status}` }));
      throw new Error((err as { error: string }).error);
    }
    return res.json();
  }

  async activateIntegration(id: string): Promise<{ ok: boolean; id: string; tools: string[]; warning?: string }> {
    const res = await this.fetch(`/mcp/integrations/${encodeURIComponent(id)}/activate`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      throw new Error(err.error || `Failed: ${res.status}`);
    }
    return res.json();
  }

  async removeMcpIntegration(id: string): Promise<void> {
    const res = await this.fetch(`/mcp/integrations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Failed to remove integration: ${res.status}`);
  }

  // ─── Team Profile Config ────────────────────────────────────────────────

  /**
   * Fetch profile-level caps + approvers for a team profile.
   * Returns null on 404 (no config set for this profile).
   * Endpoint: GET /api/groups/:id/profile-config/:profileId
   */
  async getTeamProfileConfig(groupId: string, profileId: string): Promise<ProfileConfig | null> {
    const res = await this.fetch(
      `/api/groups/${encodeURIComponent(groupId)}/profile-config/${encodeURIComponent(profileId)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) return null;
    // SP wraps the config in { profileId, config } — unwrap it to match
    // the ProfileConfig type the rest of the gateway expects.
    const body = await res.json();
    return (body?.config as ProfileConfig) ?? null;
  }

  /**
   * Set (or replace) profile-level caps + approvers. Admin-only on the SP side.
   * Endpoint: PUT /api/groups/:id/profile-config/:profileId
   */
  async setTeamProfileConfig(groupId: string, profileId: string, config: ProfileConfig): Promise<void> {
    const res = await this.fetch(
      `/api/groups/${encodeURIComponent(groupId)}/profile-config/${encodeURIComponent(profileId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(config),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to set profile config' }));
      throw new Error((err as { error: string }).error || `setTeamProfileConfig failed: ${res.status}`);
    }
  }

  /**
   * Encrypt an intent for a set of recipients via the control-plane.
   * Calls POST /api/encrypt-intent (does not touch the SP; handled by CP).
   */
  async encryptIntent(
    intent: string,
    recipients: Array<{ userId: string; publicKey: string }>,
  ): Promise<{
    intentCiphertext: string;
    encryptedKeys: Record<string, { ct: string; enc: string }>;
    approversFrozen: string[];
  }> {
    const res = await this.fetch('/api/encrypt-intent', {
      method: 'POST',
      body: JSON.stringify({ intent, recipients }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Encryption failed' }));
      throw new Error((err as { error: string }).error || `encryptIntent failed: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Fetch public keys for all current approvers on a profile.
   * Returns an array of { userId, publicKey } — only users who have registered
   * a key are included. Empty array = no approvers have keys (skip encryption).
   * Endpoint: GET /api/groups/:id/profile-config/:profileId/approvers/pubkeys
   */
  async getApproversPubkeys(groupId: string, profileId: string): Promise<Array<{ userId: string; publicKey: string }>> {
    const res = await this.fetch(
      `/api/groups/${encodeURIComponent(groupId)}/profile-config/${encodeURIComponent(profileId)}/approvers/pubkeys`,
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.approvers as Array<{ userId: string; publicKey: string }>) ?? [];
  }

  /**
   * Delete the profile config for a team profile. Admin-only on the SP side.
   * Endpoint: DELETE /api/groups/:id/profile-config/:profileId
   */
  async deleteTeamProfileConfig(groupId: string, profileId: string): Promise<void> {
    const res = await this.fetch(
      `/api/groups/${encodeURIComponent(groupId)}/profile-config/${encodeURIComponent(profileId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to delete profile config' }));
      throw new Error((err as { error: string }).error || `deleteTeamProfileConfig failed: ${res.status}`);
    }
  }

  // ─── Proposals ──────────────────────────────────────────────────────────

  async getProposals(domain: string): Promise<Proposal[]> {
    const res = await this.fetch(`/api/proposals?domain=${encodeURIComponent(domain)}`);
    if (!res.ok) throw new Error(`Failed to fetch proposals: ${res.status}`);
    const data = await res.json();
    return data.proposals ?? [];
  }

  async resolveProposal(id: string, action: 'commit' | 'reject', domain: string): Promise<{ status: string }> {
    const res = await this.fetch(`/api/proposals/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action, domain }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      throw new Error(err.error || `Failed: ${res.status}`);
    }
    return res.json();
  }

  // ─── Phase 6: Per-action approver proposals ─────────────────────────────

  /**
   * Fetch proposals where the caller is a required approver and has not yet approved.
   * SP endpoint: GET /api/proposals?approver=me
   */
  async getProposalsForApprover(): Promise<Proposal[]> {
    const res = await this.fetch('/api/proposals?approver=me');
    if (!res.ok) throw new Error(`Failed to fetch approver proposals: ${res.status}`);
    const data = await res.json();
    return data.proposals ?? [];
  }

  /**
   * Approve an above-cap action proposal.
   * SP endpoint: POST /api/proposals/:id/approve
   */
  async approveProposal(id: string): Promise<{ receipt: Record<string, unknown>; status: string; approvedBy: Record<string, { receiptId: string; at: number }> }> {
    const res = await this.fetch(`/api/proposals/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      throw new Error((err as { error: string }).error || `approveProposal failed: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Reject an above-cap action proposal.
   * SP endpoint: POST /api/proposals/:id/reject
   */
  async rejectProposal(id: string, reason?: string): Promise<{ receipt: Record<string, unknown>; status: string }> {
    const res = await this.fetch(`/api/proposals/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      throw new Error((err as { error: string }).error || `rejectProposal failed: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Fetch E2EE encrypted intent for an authority.
   * Returns the bulk ciphertext + the caller's HPKE key wrap.
   * SP endpoint: GET /api/attestations/:frameHash/intent
   */
  async getAttestationIntent(frameHash: string): Promise<{
    intentCiphertext: string;
    encryptedKey: { ct: string; enc: string };
    approversFrozen: string[];
  } | null> {
    const res = await this.fetch(`/api/attestations/${encodeURIComponent(frameHash)}/intent`);
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) return null;
    return res.json();
  }

  /**
   * Decrypt an intent on the control-plane using the vault's private HPKE key.
   * CP endpoint: POST /api/decrypt-intent
   */
  async decryptIntent(params: {
    intentCiphertext: string;
    encryptedKey: { ct: string; enc: string };
    approverId: string;
  }): Promise<string> {
    const res = await this.fetch('/api/decrypt-intent', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Decryption failed' }));
      throw new Error((err as { error: string }).error || `decryptIntent failed: ${res.status}`);
    }
    const data = await res.json() as { intent: string };
    return data.intent;
  }

  /**
   * Persist a decrypted intent as an approver accountability record.
   * CP endpoint: POST /api/approved-intents
   */
  async storeApprovedIntent(authorityId: string, intent: string): Promise<void> {
    const res = await this.fetch('/api/approved-intents', {
      method: 'POST',
      body: JSON.stringify({ authorityId, intent }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      throw new Error((err as { error: string }).error || `storeApprovedIntent failed: ${res.status}`);
    }
  }

  // ─── Phase 7: Team governance views ────────────────────────────────────

  /**
   * Fetch all authorizations for a group (admin-only).
   * SP endpoint: GET /api/groups/:id/attestations
   * Returns the standard PendingItem shape plus an `owner` field per item.
   */
  async listTeamAuthorizations(groupId: string): Promise<Array<PendingItem & { owner: { userId: string; name?: string; email?: string } }>> {
    const res = await this.fetch(`/api/groups/${encodeURIComponent(groupId)}/attestations`);
    if (!res.ok) throw new Error(`Failed to fetch team authorizations: ${res.status}`);
    const data = await res.json();
    return (data.items ?? []).map((a: Record<string, unknown>) => {
      const owner = (a.owner as { userId: string; name?: string; email?: string }) ?? { userId: '' };
      const item: PendingItem & { owner: { userId: string; name?: string; email?: string } } = {
        frame_hash: (a.boundsHash ?? a.frameHash ?? a.frame_hash) as string,
        profile_id: (a.profileId ?? a.profile_id) as string,
        path: (a.path ?? '') as string,
        title: (a.title ?? null) as string | null,
        sp_status: (a.status ?? a.sp_status ?? null) as string | null,
        frame: (a.bounds ?? a.frame ?? {}) as Record<string, string | number>,
        required_domains: (a.requiredDomains ?? a.required_domains ?? []) as string[],
        attested_domains: (a.attestedDomains ?? a.attested_domains ?? []) as string[],
        missing_domains: ((a.requiredDomains ?? a.required_domains ?? []) as string[]).filter(
          (d: string) => !((a.attestedDomains ?? a.attested_domains ?? []) as string[]).includes(d)
        ),
        deferred_commitment_domains: (a.deferredCommitmentDomains ?? a.deferred_commitment_domains ?? []) as string[],
        approvers_frozen: (a.approversFrozen ?? a.approvers_frozen ?? []) as string[],
        above_cap: (a.aboveCap ?? a.above_cap ?? false) as boolean,
        created_at: a.createdAt ? new Date((a.createdAt as number) * 1000).toISOString() : (a.created_at as string ?? ''),
        earliest_expiry: (a.attestations as Array<{ expiresAt: number }> | undefined)?.length
          ? new Date(Math.min(...(a.attestations as Array<{ expiresAt: number }>).map(att => att.expiresAt)) * 1000).toISOString()
          : null,
        remaining_seconds: (a.attestations as Array<{ expiresAt: number }> | undefined)?.length
          ? Math.max(0, Math.min(...(a.attestations as Array<{ expiresAt: number }>).map(att => att.expiresAt)) - Math.floor(Date.now() / 1000))
          : null,
        owner,
      };
      return item;
    });
  }

  /**
   * Fetch execution receipts for a group (admin sees team-wide; others see own).
   * SP endpoint: GET /api/groups/:id/receipts
   */
  async listTeamReceipts(groupId: string): Promise<ExecutionReceipt[]> {
    const res = await this.fetch(`/api/groups/${encodeURIComponent(groupId)}/receipts`);
    if (!res.ok) throw new Error(`Failed to fetch team receipts: ${res.status}`);
    const data = await res.json();
    return data.receipts ?? [];
  }

  /**
   * Paged receipts for the audit view. The SP walks a window of days backward
   * from `before` (a YYYY-MM-DD cursor) and returns `nextBefore` for "Load
   * older" — null once the history floor is reached. Without `before` it
   * returns the most recent window.
   */
  async getMyReceiptsPage(options?: { before?: string; profile?: string; limit?: number }): Promise<ReceiptPage> {
    const params = new URLSearchParams();
    if (options?.before) params.set('before', options.before);
    if (options?.profile) params.set('profile', options.profile);
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    const res = await this.fetch(`/api/receipts/mine${qs ? '?' + qs : ''}`);
    if (!res.ok) throw new Error(`Failed to fetch receipts: ${res.status}`);
    const data = await res.json();
    return { receipts: data.receipts ?? [], nextBefore: data.nextBefore ?? null };
  }

  async listTeamReceiptsPage(groupId: string, options?: { before?: string; profile?: string; limit?: number }): Promise<ReceiptPage> {
    const params = new URLSearchParams();
    if (options?.before) params.set('before', options.before);
    if (options?.profile) params.set('profile', options.profile);
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    const res = await this.fetch(`/api/groups/${encodeURIComponent(groupId)}/receipts${qs ? '?' + qs : ''}`);
    if (!res.ok) throw new Error(`Failed to fetch team receipts: ${res.status}`);
    const data = await res.json();
    return { receipts: data.receipts ?? [], nextBefore: data.nextBefore ?? null };
  }

  // ─── Action Thread (homepage feed) ──────────────────────────────────────

  /**
   * Fetch a merged stream of proposals + receipts for the Action Thread.
   * The SP's `/api/receipts/mine` endpoint is date-keyed (one day at a
   * time), so multi-day history is assembled by looping over recent dates.
   */
  async getThread(options: {
    domain: string;
    sinceDays?: number;
    status?: 'pending' | 'all';
    profile?: string;
    includeAutonomous?: boolean;
    limit?: number;
  }): Promise<{ proposals: Proposal[]; receipts: ExecutionReceipt[] }> {
    const sinceDays = options.sinceDays ?? 7;
    const status = options.status ?? 'pending';

    // Match the Sidebar's fallback: when the user has no active domain (fresh
    // session, no group joined yet), query the personal 'owner' domain.
    const domain = options.domain || 'owner';
    const proposals = await this.getProposals(domain);

    let receipts: ExecutionReceipt[] = [];
    if (status === 'all') {
      const dates: string[] = [];
      const today = new Date();
      for (let i = 0; i < sinceDays; i++) {
        const d = new Date(today);
        d.setUTCDate(today.getUTCDate() - i);
        dates.push(d.toISOString().slice(0, 10));
      }
      const perDay = await Promise.all(
        dates.map((date) => this.getMyReceipts({ date, profile: options.profile })),
      );
      receipts = perDay.flat();
    }

    return { proposals, receipts };
  }

  // ─── Gate Content ───────────────────────────────────────────────────────

  async getGateContent(path: string): Promise<GateContentEntry | null> {
    const res = await this.fetch(`/gate-content?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(`Failed to fetch gate content: ${res.status}`);
    const data = await res.json();
    return data.entry ?? null;
  }

  /**
   * Enriched ACTIVE authorizations (the same set list-authorizations shows —
   * cache-backed, no stale entries), each with its local context (scope). Used
   * to compare a new grant's scope against existing grants at creation time.
   * Context stays local (privacy-blind) — this never touches the AS.
   */
  async getEnrichedAuthorizations(): Promise<EnrichedAuthorizationEntry[]> {
    const res = await this.fetch('/active-authorizations');
    if (!res.ok) throw new Error(`Failed to fetch authorizations: ${res.status}`);
    const data = await res.json();
    return data.authorizations ?? [];
  }

  async pushGateContent(data: {
    frameHash?: string;     // v0.3
    boundsHash?: string;    // v0.4
    contextHash?: string;   // v0.4
    context?: Record<string, string | number>;  // v0.4
    path?: string;
    gateContent: Record<string, string>;
  }): Promise<void> {
    const res = await this.fetch('/gate-content', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to push gate content' }));
      throw new Error(err.error || `Push gate content failed: ${res.status}`);
    }
  }

  // ─── Agent Brief (context.md + session-brief preview) ─────────────────

  async getAgentContext(): Promise<string> {
    const res = await this.fetch('/agent-brief/context');
    if (!res.ok) throw new Error(`Failed to fetch agent context: ${res.status}`);
    const data = await res.json() as { content: string };
    return data.content;
  }

  async saveAgentContext(content: string): Promise<void> {
    const res = await this.fetch('/agent-brief/context', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to save agent context' }));
      throw new Error((err as { error: string }).error || `Save failed: ${res.status}`);
    }
  }

  // ─── AI chat (multi-turn refinement of context.md or intent) ──────────

  async aiChat(request: {
    target: { kind: 'context' } | { kind: 'intent'; profileId?: string; path?: string; bounds?: string };
    currentText: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  }): Promise<{ success: boolean; reply?: string; error?: string }> {
    const res = await this.fetch('/ai/chat', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'AI chat failed' }));
      return { success: false, error: (err as { error: string }).error || `Chat failed: ${res.status}` };
    }
    return res.json() as Promise<{ success: boolean; reply?: string; error?: string }>;
  }

  /** Read the current AI assistant system prompts (intent + context),
   *  including immutable defaults so the UI can compare. */
  async getAIPrompts(): Promise<Record<'intent' | 'context', { current: string; default: string; overridden: boolean }>> {
    const res = await this.fetch('/ai-prompts');
    if (!res.ok) throw new Error(`Failed to load AI prompts: ${res.status}`);
    return res.json() as Promise<Record<'intent' | 'context', { current: string; default: string; overridden: boolean }>>;
  }

  /** Save (or revert with empty value) an override for one prompt kind. */
  async setAIPrompt(kind: 'intent' | 'context', value: string): Promise<void> {
    const res = await this.fetch(`/ai-prompts/${kind}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Save failed' }));
      throw new Error((err as { error: string }).error || `Save failed: ${res.status}`);
    }
  }
}

export const spClient = new SPClient();
