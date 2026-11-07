/**
 * The read-only "Data folder" line on the Settings page.
 *
 * The wording is ONE constant so it can be changed in one place. House rule:
 * never claim more than the code does — see the report on what is and is not
 * encrypted before changing it.
 */
export const DATA_FOLDER_LABEL = 'Data folder:';
// Option 2, approved by Andreas 2026-11-06 — the approved draft claimed everything was encrypted, which is not true.
export const DATA_FOLDER_NOTE = 'everything the gateway stores on this computer. Credentials, tickets and logs are encrypted; connector databases (CRM, records, ERP, email) are not.';

/**
 * Split a path into pieces that may wrap after each separator, so a long
 * path breaks at folder boundaries instead of mid-name. Works for POSIX and
 * Windows (backslash) paths; the path itself is never altered.
 */
export function pathWrapParts(path: string): string[] {
  return path.match(/[^\\/]*[\\/]?/g)?.filter(Boolean) ?? [];
}
