/**
 * Is this page driven by browser automation that says so (`navigator.webdriver`)?
 *
 * Defense in depth only. An AI with browser control must never sign in to the
 * gateway or approve here (it could read the API key and approve its own
 * proposals). This catches automation that announces itself (WebDriver, CDP
 * tools like Playwright by default). It does NOT catch an AI driving the
 * person's real browser (Claude in Chrome) or their screen (computer use) —
 * those report false. The guarantee has to come from a human-only factor
 * (work plan: passkey approval), and from the rule the agent is told.
 */
export function isAutomatedBrowser(): boolean {
  return typeof navigator !== 'undefined' && navigator.webdriver === true;
}

/** Shown when an automated browser tries to sign in or approve. */
export const AUTOMATION_REFUSAL =
  'This browser is controlled by automation. Sign-in and approvals are for a person only — open the gateway in your own browser.';
