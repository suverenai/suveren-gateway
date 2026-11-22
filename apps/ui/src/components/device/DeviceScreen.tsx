import type { ReactNode } from 'react';
import { DeviceFrame } from '@suveren/approval-card/components/DeviceFrame';
import { TopNav } from '../TopNav';
import { UpdateBanner } from '../UpdateBanner';
import { SimulationBanner } from '../SimulationBanner';

// The frame and its small pieces are shared with the phone app (packages/approval-card): one implementation.
export { useDriver, Notice, PrintScope, CodeInput } from '@suveren/approval-card/components/DeviceFrame';

/** The frame of every device-key screen: the top bar and one centred column (the look of the sign-in). */
export function DeviceScreen({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <>
      <TopNav />
      <UpdateBanner />
      {/* As on the old sign-in and in the app's frame: in simulation mode the banner says so on these screens too, and
          the frame that follows (the dashboard greyed out) starts with it, so nothing moves down after the sign-in. */}
      <SimulationBanner />
      {/* The top bar is fixed: this column starts below it (and below the update banner when it shows). */}
      <div className="device-page"><DeviceFrame title={title}>{children}</DeviceFrame></div>
    </>
  );
}
