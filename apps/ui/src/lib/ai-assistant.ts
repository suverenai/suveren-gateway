/**
 * TO BE INVESTIGATED (Andreas, 2026-10-24): the in-gateway AI assistant — the
 * brief helper (Agent Brief), the intent helper and its check (mandate wizard),
 * and Settings → AI Assistant — is hidden while we rethink it. Nothing is
 * deleted: the code stays, and an `ai-config` credential already in the vault is
 * left untouched. Its nudges are hidden with it (Settings nav badge, dashboard
 * "AI Assistant not configured", the Get started step), since they would point
 * to a section that is not shown. Set to true to bring it all back.
 */
export const AI_ASSISTANT_VISIBLE: boolean = false;
