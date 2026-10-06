import type { IconName } from '../lib/profile-identity';

/**
 * One neutral line icon per profile — never a color, see lib/profile-identity.ts.
 * 24px viewBox, round caps/joins, 1.75px stroke, currentColor only (no fill),
 * so it always matches whatever text color surrounds it in light or dark
 * theme. Hand-authored paths (Lucide-style) — the project has no icon
 * library dependency, and this is a small, fixed set.
 *
 * `aria-hidden`: the profile name is always rendered as text beside the
 * icon, so the icon itself carries no information a screen reader needs.
 */

const PATHS: Record<IconName, React.ReactNode> = {
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c0-3.6 2.5-6.3 5.5-6.3s5.5 2.7 5.5 6.3" />
      <circle cx="17.2" cy="9.2" r="2.3" />
      <path d="M16.8 13.9c2.4.5 4.2 2.6 4.2 5.4" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 3h12v18l-2.2-1.4L14 21l-2-1.4L10 21l-2-1.4L6 21V3Z" />
      <line x1="9" y1="7.5" x2="15" y2="7.5" />
      <line x1="9" y1="11.5" x2="15" y2="11.5" />
      <line x1="9" y1="15.5" x2="13" y2="15.5" />
    </>
  ),
  'credit-card': (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2.2" />
      <line x1="2" y1="10" x2="22" y2="10" />
      <line x1="5.5" y1="15" x2="9.5" y2="15" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4.5" width="18" height="16.5" rx="2" />
      <line x1="3" y1="9.5" x2="21" y2="9.5" />
      <line x1="8" y1="2.5" x2="8" y2="6.5" />
      <line x1="16" y1="2.5" x2="16" y2="6.5" />
    </>
  ),
  megaphone: (
    <>
      <path d="M3 10.2v3.6c0 .7.6 1.2 1.2 1.2h2.6l6.4 4V5l-6.4 4H4.2C3.6 9 3 9.5 3 10.2Z" />
      <path d="M14.5 8.3a4.3 4.3 0 0 1 0 7.4" />
      <path d="M17.6 6a7.6 7.6 0 0 1 0 12" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="3.5" width="18" height="5" rx="1.2" />
      <path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5" />
      <line x1="10" y1="13" x2="14" y2="13" />
    </>
  ),
  rocket: (
    <>
      <path d="M12 2.2c2.4 2 3.8 5.3 3.8 8.6 0 1.9-.9 3.9-.9 3.9H9.1s-.9-2-.9-3.9c0-3.3 1.4-6.6 3.8-8.6Z" />
      <path d="M9 14.7 6.3 19.4l3.8-1.7" />
      <path d="M15 14.7l2.7 4.7-3.8-1.7" />
      <circle cx="12" cy="9.3" r="1.3" />
    </>
  ),
  flask: (
    <>
      <path d="M9 3h6" />
      <path d="M10 3v6.3l-5 9.1A2 2 0 0 0 6.7 21.5h10.6a2 2 0 0 0 1.7-3.1l-5-9.1V3" />
      <line x1="8.3" y1="14.5" x2="15.7" y2="14.5" />
    </>
  ),
  'shopping-cart': (
    <>
      <circle cx="9" cy="20" r="1.4" />
      <circle cx="18" cy="20" r="1.4" />
      <path d="M2.5 3h2.4l2.1 11.2a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6l1.4-7.6H6" />
    </>
  ),
  'bar-chart': (
    <>
      <line x1="4" y1="20.5" x2="20" y2="20.5" />
      <rect x="6" y="13" width="3.2" height="7.5" />
      <rect x="11.4" y="8.5" width="3.2" height="12" />
      <rect x="16.8" y="4" width="3.2" height="16.5" />
    </>
  ),
  'help-circle': (
    <>
      <circle cx="12" cy="12" r="9.2" />
      <path d="M9.6 9.6a2.5 2.5 0 1 1 3.6 2.3c-.9.5-1.4 1.1-1.4 2.2" />
      <line x1="12" y1="17" x2="12" y2="17.05" />
    </>
  ),
};

interface Props {
  icon: IconName;
  className?: string;
}

export function ProfileIcon({ icon, className }: Props) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[icon]}
    </svg>
  );
}
