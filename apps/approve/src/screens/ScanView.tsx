import { useEffect, useRef, useState } from 'react';
import { Scanner, type ScanFailure, type ScanProgress } from '../lib/scan';
import { P, scanFailureText } from '../texts';
import { Notice } from './Frame';

/**
 * The camera view. The preview can stay black on an iPhone (device test, check 7), so the screen always shows a frame, a line
 * that says what to do, and honest progress: how long the phone has been looking.
 */
export function ScanView({ onText, onCancel }: { onText: (text: string) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const scanner = useRef<Scanner | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [failure, setFailure] = useState<ScanFailure | null>(null);

  useEffect(() => {
    const s = new Scanner();
    scanner.current = s;
    if (video.current) {
      void s.start(video.current, { onText, onProgress: setProgress, onFailure: setFailure });
    }
    return () => s.stop();
    // The handlers are the parent's; the camera starts once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div data-testid="scan-view">
      {failure && <Notice kind="error">{scanFailureText(failure)}</Notice>}
      <div className="ap-scan">
        <video ref={video} playsInline muted />
        <div className="ap-scan-frame" aria-hidden="true" />
      </div>
      {!failure && (
        <>
          <p className="ap-scan-line" role="status">{P.scanFrame}</p>
          <p className="ap-scan-line" role="status" data-testid="scan-progress">{P.scanProgress(progress?.seconds ?? 0)}</p>
          <p className="ap-scan-line" style={{ color: 'var(--text-muted)' }}>{P.scanBlackNote}</p>
        </>
      )}
      <button type="button" className="btn btn-ghost btn-full" onClick={() => { scanner.current?.stop(); onCancel(); }}>{P.scanStop}</button>
    </div>
  );
}
