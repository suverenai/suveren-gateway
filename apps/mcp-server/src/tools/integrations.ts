/**
 * list-integrations tool — compact overview of all running integrations
 * and their authorization status.
 *
 * Always callable, no parameters. Returns minimal context so the agent
 * knows what's available without bloating the conversation.
 */

import type { SharedState } from '../lib/shared-state';
import type { IntegrationManager } from '../lib/integration-manager';
import { profileMatches } from '../lib/tool-proxy';

/** Extract short profile name from full ID */
function shortProfileName(profileId: string): string {
  const withoutVersion = profileId.replace(/@.*$/, '');
  const parts = withoutVersion.split('/');
  return parts[parts.length - 1];
}

export function listIntegrationsHandler(
  state: SharedState,
  integrationManager: IntegrationManager | undefined,
) {
  return async () => {
    if (!integrationManager) {
      return { content: [{ type: 'text' as const, text: 'No integration manager available.' }] };
    }

    const auths = state.getEnrichedAuthorizations();
    const statuses = integrationManager.getStatus();

    const integrations = statuses
      .filter(s => s.running)
      .map(s => {
        // Find the profile for this integration from its tools
        const tools = integrationManager.getAllTools().filter(t => t.integrationId === s.id);
        const profile = tools[0]?.gating?.profile ?? null;

        // Count active authorizations matching this profile
        const matchingAuths = profile
          ? auths.filter(a => a.complete && profileMatches(a.profileId, profile))
          : [];

        // Determine status
        let status: string;
        if (matchingAuths.length > 0) {
          // Find soonest expiry
          const soonestExpiry = Math.min(
            ...matchingAuths.flatMap(a =>
              a.attestations.map(att => att.expiresAt)
            ),
          );
          const remainingMs = soonestExpiry * 1000 - Date.now();
          const remainingMin = Math.ceil(remainingMs / 60000);
          status = `authorized (${matchingAuths.length} path${matchingAuths.length > 1 ? 's' : ''}, ${remainingMin} min remaining)`;
        } else {
          // Check if there are expired auths
          const allProfileAuths = profile
            ? auths.filter(a => profileMatches(a.profileId, profile))
            : [];
          status = allProfileAuths.length > 0 ? 'expired' : 'no authorization';
        }

        return {
          id: s.id,
          profile: profile ? shortProfileName(profile) : null,
          status,
        };
      });

    const text = integrations.length === 0
      ? 'No integrations running.'
      : integrations.map(i =>
          `${i.id} [${i.profile ?? 'ungated'}] — ${i.status}`
        ).join('\n');

    return {
      content: [{ type: 'text' as const, text }],
    };
  };
}
