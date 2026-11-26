import { BrandRow } from '@suveren/approval-card/components/BrandMark';
import { ThemeToggle } from '@suveren/approval-card/components/ThemeToggle';

/** The top line of every phone screen outside the approval panel: the brand at the left, the theme switch at the right. */
export function PhoneTop() {
  return <div className="ap-top"><BrandRow badge="Approvals" /><ThemeToggle /></div>;
}
