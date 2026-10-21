import type { AreaIconName } from '../lib/area';

/**
 * One drawn, monochrome icon per area (UI spec §13.1) — copied from the
 * signed-off mockup `suveren-as/docs/ui-spec/areas.html` (symbols
 * `a-customers` … `a-setup`), same conventions as `ProfileIcon.tsx`: 24px
 * viewBox, `currentColor` stroke only, no fill, so it matches whatever text
 * colour surrounds it in light or dark theme.
 *
 * `aria-hidden`: the area name is always rendered as text beside the icon
 * (see `ObjectLine.tsx`), so the icon itself carries no information a
 * screen reader needs.
 */

const PATHS: Record<AreaIconName, React.ReactNode> = {
  customers: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M15.5 13.8c3 .1 5.5 2 5.5 5" />
    </>
  ),
  email: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <path d="m3.5 6 8.5 7 8.5-7" />
    </>
  ),
  payments: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="1.5" />
      <path d="M3 10h18M7 15h4" />
    </>
  ),
  sales: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4M9 12h7M9 16h5" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="1.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  records: <path d="M3 7h7l2 2h9v10H3z" />,
  publishing: (
    <>
      <path d="M4 10v4l11 4V6z" />
      <path d="M15 9.5c2 .3 3 1.3 3 2.5s-1 2.2-3 2.5M7 14.5 8.5 19h2.5l-1.3-4" />
    </>
  ),
  deployments: (
    <>
      <path d="M12 3v12M7 8l5-5 5 5" />
      <path d="M4 15v5h16v-5" />
    </>
  ),
  invoicing: (
    <>
      <path d="M6 3h12v18l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3L6 21z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </>
  ),
  // Master data — an index card with a tab (picked by Andreas 2026-10-21,
  // temp/master-data-icon-mockup candidate A).
  masterData: (
    <>
      <path d="M4.5 7.5h15a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V9a1.5 1.5 0 0 1 1.5-1.5z" />
      <path d="M6 7.5V5h6v2.5M7 12h10M7 16h6" />
    </>
  ),
  purchasing: (
    <>
      <path d="M3 4h2.5l2.2 11h10.6L20.5 7H6.4" />
      <circle cx="9" cy="19" r="1.4" />
      <circle cx="17" cy="19" r="1.4" />
    </>
  ),
  reports: (
    <>
      <path d="M4 20V4M4 20h16" />
      <path d="M8 16v-4M12 16V8M16 16v-6" />
    </>
  ),
  setup: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  // Unknown area — a neutral circle-question mark, same shape family as
  // ProfileIcon's 'help-circle', never guessed from the id beyond this.
  unknown: (
    <>
      <circle cx="12" cy="12" r="9.2" />
      <path d="M9.6 9.6a2.5 2.5 0 1 1 3.6 2.3c-.9.5-1.4 1.1-1.4 2.2" />
      <line x1="12" y1="17" x2="12" y2="17.05" />
    </>
  ),
};

interface Props {
  icon: AreaIconName;
  className?: string;
}

export function AreaIcon({ icon, className }: Props) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[icon]}
    </svg>
  );
}
