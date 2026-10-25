// Barcode scanning.
//
// Two engines, chosen at runtime because the platforms differ:
//   Android Chrome -> BarcodeDetector, a native decoder: very fast, runs the
//                     whole video frame, no WASM download.
//   iPhone Safari   -> no BarcodeDetector at all, so a bundled zxing (WASM-free
//                     JS) decodes downscaled canvas snapshots instead.
//
// Speed comes from decoding a downscaled frame and from de-duplicating: the
// same ISBN is ignored for 2.5s after it is read, so holding the phone still
// does not fire the same result twenty times.

const DEDUPE_MS = 2500;
const NATIVE_INTERVAL_MS = 110;
const FALLBACK_INTERVAL_MS = 260;
const DECODE_SCALE = 0.55;

let stream = null;
let running = false;
let timer = null;
let detector = null;
let zxingReader = null;
let videoEl = null;
let canvas = null;
let ctx = null;
let onCodeCb = () => {};
let onStatusCb = () => {};
let lastValue = '';
let lastValueAt = 0;

export function isRunning() {
  return running;
}

function accept(raw) {
  const value = String(raw ?? '').replace(/[^0-9Xx]/g, '');
  if (!value) return;
  const now = Date.now();
  if (value === lastValue && now - lastValueAt < DEDUPE_MS) return;
  lastValue = value;
  lastValueAt = now;
  // A short buzz confirms the read without needing to look at the screen.
  navigator.vibrate?.(35);
  onCodeCb(value);
}

async function ensureZxing() {
  if (window.ZXing) return window.ZXing;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/zxing.min.js';
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('could not load the barcode decoder'));
    document.head.append(script);
  });
  return window.ZXing;
}

/** Native path: detect on the live video element, throttled. */
async function nativeLoop() {
  while (running) {
    try {
      const codes = await detector.detect(videoEl);
      for (const code of codes) {
        if (code.format === 'ean_13' || code.format === 'ean_8' || code.format === 'upc_a') {
          accept(code.rawValue);
          break;
        }
      }
    } catch {
      // A frame that fails to decode is normal, not an error worth surfacing.
    }
    if (!running) break;
    await new Promise((r) => setTimeout(r, NATIVE_INTERVAL_MS));
  }
}

/** Fallback path: snapshot a downscaled canvas and hand it to zxing. */
async function fallbackLoop() {
  const ZXing = await ensureZxing();
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
    ZXing.BarcodeFormat.EAN_13,
    ZXing.BarcodeFormat.EAN_8,
    ZXing.BarcodeFormat.UPC_A,
  ]);
  zxingReader = new ZXing.MultiFormatReader();
  zxingReader.setHints(hints);

  while (running) {
    try {
      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;
      if (vw && vh) {
        const w = Math.round(vw * DECODE_SCALE);
        const h = Math.round(vh * DECODE_SCALE);
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(videoEl, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);

        // zxing wants one luminance byte per pixel; folding RGBA here is cheaper
        // than letting it guess at the buffer layout.
        const lum = new Uint8ClampedArray(w * h);
        for (let i = 0, j = 0; j < lum.length; i += 4, j += 1) {
          lum[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
        }
        const source = new ZXing.RGBLuminanceSource(lum, w, h);
        const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source));
        const result = zxingReader.decode(bitmap, hints);
        if (result?.getText?.()) accept(result.getText());
      }
    } catch {
      // NotFoundException each frame without a barcode - expected, stay quiet.
    }
    if (!running) break;
    await new Promise((r) => setTimeout(r, FALLBACK_INTERVAL_MS));
  }
}

/** Returns true only when a camera is actually streaming, so the UI can put the
 *  button back to "Start camera" when permission is refused or no camera exists. */
export async function startScanner({ video, onCode, onStatus }) {
  if (running) return true;
  videoEl = video;
  onCodeCb = onCode ?? (() => {});
  onStatusCb = onStatus ?? (() => {});

  if (!window.isSecureContext) {
    onStatusCb('Camera needs HTTPS. Open this page over https:// — not http://.', 'error');
    return false;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    onStatusCb('This browser has no camera access. Use Type ISBN instead.', 'error');
    return false;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
  } catch (error) {
    const name = error?.name ?? '';
    const message =
      name === 'NotAllowedError'
        ? 'Camera permission denied. Allow it in the browser settings, then reload.'
        : name === 'NotFoundError'
          ? 'No camera found on this device.'
          : `Camera unavailable (${name || 'unknown'}). Use Type ISBN instead.`;
    onStatusCb(message, 'error');
    return false;
  }

  videoEl.srcObject = stream;
  await videoEl.play().catch(() => {});
  running = true;

  canvas = document.createElement('canvas');
  ctx = canvas.getContext('2d', { willReadFrequently: true });

  const supported =
    'BarcodeDetector' in window
      ? await window.BarcodeDetector.getSupportedFormats().catch(() => [])
      : [];

  if (supported.includes('ean_13')) {
    detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
    onStatusCb('Point at the barcode — scanning fast.');
    nativeLoop();
  } else {
    onStatusCb('Point at the barcode — using compatibility scanner.');
    fallbackLoop().catch((error) => {
      onStatusCb(String(error?.message ?? error), 'error');
      stopScanner();
    });
  }
  return true;
}

export function stopScanner() {
  running = false;
  clearTimeout(timer);
  timer = null;
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (videoEl) videoEl.srcObject = null;
  detector = null;
  zxingReader = null;
}

function torchTrack() {
  const track = stream?.getVideoTracks?.()[0];
  if (!track || track.readyState === 'ended') return null;
  return track;
}

/** Does this camera advertise a torch? Independent of whether it is on. */
export async function hasTorch() {
  const track = torchTrack();
  if (!track?.getCapabilities) return false;
  try {
    return Boolean(track.getCapabilities().torch);
  } catch {
    return false;
  }
}

/**
 * The ACTUAL torch state, read from the camera rather than remembered.
 * The button used to keep its own boolean, so after the OS or the browser turned
 * the light off the next tap sent "off" to a light that was already off and the
 * app reported a failure. Read the hardware instead.
 */
export async function getTorchState() {
  const track = torchTrack();
  if (!track?.getSettings) return false;
  try {
    return Boolean(track.getSettings().torch);
  } catch {
    return false;
  }
}

/**
 * Try to set the torch. Returns { ok, supported, needsRestart }.
 * Two constraint shapes are tried because devices disagree: Chrome wants
 * `advanced: [{torch}]`, some builds accept the flat form.
 */
export async function setTorch(on) {
  const track = torchTrack();
  if (!track) return { ok: false, supported: true, needsRestart: true };

  let supported = false;
  try {
    supported = Boolean(track.getCapabilities?.().torch);
  } catch {
    supported = false;
  }
  if (!supported) return { ok: false, supported: false };

  const desired = Boolean(on);
  for (const constraints of [{ advanced: [{ torch: desired }] }, { torch: desired }]) {
    try {
      await track.applyConstraints(constraints);
      const now = track.getSettings?.().torch;
      // Verify: some implementations resolve without changing anything.
      if (now === undefined || Boolean(now) === desired) {
        return { ok: true, supported: true };
      }
    } catch {
      // try the next shape
    }
  }
  return { ok: false, supported: true };
}
