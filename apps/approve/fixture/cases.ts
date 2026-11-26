/**
 * The proposals the card-parity page draws, twice: on the gateway's approval card and on the phone's give. Invented data only (Muster
 * names, example.com); the profiles are the real ones of hap-profiles (`__PROFILES__`, read by the page's vite config).
 */
export interface ParityCase {
  id: string;
  /** Folder and version of the real profile. */
  folder: string; version: string;
  title: string; mode: 'review' | 'automatic';
  limits: Record<string, string | number>;
  scope: Record<string, string>;
  intent: string;
  durationHours: number;
  /** The Request and History the computer read (shown on both cards, from the same data). */
  request?: boolean;
}

export const CASES: ParityCase[] = [
  { id: 'crm', folder: 'customers', version: '0.12', title: 'Leads and customers', mode: 'review', durationHours: 720,
    limits: { read_access: 'unlimited', export_access: 'none', write_daily_max: 50, delete_daily_max: 0, setup_daily_max: 0 }, scope: { contact_type: 'customer,lead,partner,vendor' },
    intent: 'Keep the contacts current: check whether a person or company is already known, create leads, and log each touchpoint as a short, factual activity.' },
  { id: 'email-resonance', folder: 'email', version: '0.11', title: 'Muster Studio', mode: 'review', durationHours: 720,
    limits: { read_access: 'unlimited', recipient_max: 1, send_daily_max: 20, send_weekly_max: 60, setup_daily_max: 0 }, scope: { allowed_recipients: 'hello@example.com', allowed_attachment_sources: 'files:saved' },
    intent: 'Answer enquiries that reach the studio address, with a short reply that a person has read first.', request: true },
  { id: 'email-private', folder: 'email', version: '0.11', title: 'Private email', mode: 'review', durationHours: 720,
    limits: { read_access: 'none', recipient_max: 3, send_daily_max: 5, send_weekly_max: 20, read_max_age_days: 30, setup_daily_max: 0 },
    scope: { allowed_recipients: 'owner@example.com,owner.work@example.com,family-member-with-a-long-address@example.com' },
    intent: 'Send the daily summary to my own addresses only, never to anyone else.' },
  { id: 'email-test', folder: 'email', version: '0.11', title: 'Email test', mode: 'automatic', durationHours: 168,
    limits: { read_access: 'unlimited', read_max_age_days: 30, recipient_max: 1, send_daily_max: 10, send_weekly_max: 40, setup_daily_max: 0 }, scope: { allowed_recipients: 'test@example.com' },
    intent: 'Test mail to my own test address while the studio is being set up.' },
  { id: 'website', folder: 'deploy', version: '0.12', title: 'Website release', mode: 'review', durationHours: 720,
    limits: { release_daily_max: 3, rollback_allowed: 'no' },
    scope: { allowed_repos: 'humanagencyprotocol/hap-protocol', allowed_environments: 'production', allowed_workflows: 'deploy-website.yml', allowed_branches: 'main' },
    intent: 'Put the current CI-built website from main live, once the build is green. No rollbacks.' },
];
