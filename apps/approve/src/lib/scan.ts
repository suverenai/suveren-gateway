/**
 * Scanning a QR code with the phone's camera, inside the app, with a bundled decoder (jsQR). No external service, no upload:
 * a frame is drawn to a canvas in the page, decoded there, and dropped (plan 8, "QR scanning").
 *
 * The pairing QR is not a URL (plan 4.3): iOS would open a URL in Safari, whose storage is not the installed app's.
 *
 * Step 1 found that on the iPhone XS the camera preview STAYS BLACK while the page reads frames (12.2 check 7) although the
 * decoding works (a 400-character code read in 0.1 to 5 seconds). So the screen cannot rely on the preview: it shows a frame
 * and a progress line ("Looking for the code... 3 s"), which come from {@link ScanProgress}. The progress is honest: it counts
 * frames really decoded.
 */
import jsQR from 'jsqr';

export interface ScanProgress {
  /** Frames the decoder has looked at. */
  frames: number;
  /** Whole seconds since the camera started. */
  seconds: number;
}

export type ScanFailure = 'camera_refused' | 'camera_unavailable' | 'timeout';

export interface ScanHandlers {
  onText: (text: string) => void;
  onProgress: (p: ScanProgress) => void;
  onFailure: (code: ScanFailure) => void;
}

/** How long to look before giving up. */
export const SCAN_TIMEOUT_MS = 60_000;
/** The widest frame that is decoded (a bigger one is scaled down: speed on a phone). */
const MAX_WIDTH = 1280;
/** A frame is decoded at most this often. */
const FRAME_MS = 120;

export class Scanner {
  private stream: MediaStream | null = null;
  private raf = 0;
  private running = false;

  /** Start the camera on `video` and read frames until a code is found, the time is up, or {@link stop} is called. */
  async start(video: HTMLVideoElement, h: ScanHandlers): Promise<void> {
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) { h.onFailure('camera_unavailable'); return; }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      h.onFailure(name === 'NotAllowedError' || name === 'SecurityError' ? 'camera_refused' : 'camera_unavailable');
      return;
    }
    video.srcObject = this.stream;
    video.setAttribute('playsinline', 'true');
    video.muted = true;
    try { await video.play(); } catch { this.stop(); h.onFailure('camera_unavailable'); return; }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) { this.stop(); h.onFailure('camera_unavailable'); return; }
    const started = Date.now();
    let last = 0;
    let frames = 0;
    this.running = true;
    const tick = (): void => {
      if (!this.running) return;
      const now = Date.now();
      if (now - started > SCAN_TIMEOUT_MS) { this.stop(); h.onFailure('timeout'); return; }
      if (video.videoWidth && now - last >= FRAME_MS) {
        last = now;
        const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        frames++;
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        h.onProgress({ frames, seconds: Math.floor((now - started) / 1000) });
        if (code && code.data) {
          this.stop();
          h.onText(code.data);
          return;
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Stop the camera and release it. Safe to call twice. */
  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
