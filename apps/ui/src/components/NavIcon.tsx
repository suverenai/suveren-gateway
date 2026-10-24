/**
 * The navigation's drawn icons (UI spec §19.1) — copied from the signed-off
 * mockup `suveren-as/docs/ui-spec/nav.html`. Same conventions as AreaIcon:
 * 24px viewBox, `currentColor` stroke 1.6, round caps and joins, no fill.
 * `aria-hidden`: the label is always rendered beside it.
 */

export type NavIconName =
  | 'dashboard' | 'approvals' | 'mandates' | 'tickets' | 'reports' | 'blocked'
  | 'team' | 'brief' | 'integrations' | 'settings';

const PATHS: Record<NavIconName, React.ReactNode> = {
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.4" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.4" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.4" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.4" />
    </>
  ),
  approvals: (
    <>
      <path d="M4 13.5 6.2 5h11.6l2.2 8.5V19H4z" />
      <path d="M4 13.5h5l1 2.2h4l1-2.2h5" />
    </>
  ),
  mandates: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4" />
      <path d="M9 12h7M8.8 17c1.2-2 2.2 1 3.4-.8s1.6-.2 3 .1" />
    </>
  ),
  tickets: (
    <>
      <path d="M3 8a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2a2 2 0 0 0 0 4v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a2 2 0 0 0 0-4z" />
      <path d="M14.5 7.5v9" strokeDasharray="1.8 2" />
    </>
  ),
  reports: <path d="M4 20h16M7 20v-6M12 20V5M17 20v-9" />,
  blocked: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 6l12 12" />
    </>
  ),
  team: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M15.5 13.8c3 .1 5.5 2 5.5 5" />
    </>
  ),
  brief: (
    <>
      <path d="M5 3.5h14v17H5z" />
      <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" />
    </>
  ),
  integrations: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />,
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
};

export function NavIcon({ name }: { name: NavIconName }) {
  return (
    <svg
      className="nav-svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
