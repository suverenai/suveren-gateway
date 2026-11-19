import type { ReactNode } from 'react';
import { DeviceFrame } from '@suveren/approval-card/components/DeviceFrame';
import { TopNav } from '../TopNav';
import { UpdateBanner } from '../UpdateBanner';

// The frame and its small pieces are shared with the phone app (packages/approval-card): one implementation.
export { useDriver, Notice, PrintScope, CodeInput } from '@suveren/approval-card/components/DeviceFrame';

/** The frame of every device-key screen: the top bar and one centred column (the look of the sign-in). */
export function DeviceScreen({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <>
      <TopNav />
      <UpdateBanner />
      <DeviceFrame title={title}>{children}</DeviceFrame>
    </>
  );
}
