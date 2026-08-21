/**
 * Find the card in a photograph.
 *
 * Runs in the browser, on the device that took the picture. That is not an implementation
 * detail — it is the reason this approach was chosen over a server-side one:
 *
 *  - No new dependency. Server-side cropping means `sharp` or OpenCV, which on this project
 *    means a native module, a rebuild, and a node_modules volume renew every time.
 *  - The pixels are already there. Cropping first turns a 4 MB phone photo into a ~200 KB
 *    upload, over the wifi of the house rather than after it.
 *  - It fails visibly. The proposed crop is drawn on screen before anything is sent.
 *
 * ## What it does and does not attempt
 *
 * It finds an **axis-aligned** card on a contrasting background, which is what you get when
 * you put a card on a table or a mat and shoot straight down — the way anybody photographing
 * a stack of cards actually shoots.
 *
 * It deliberately does **not** attempt perspective correction. A four-corner homography
 * without OpenCV is a great deal of fragile code, and the failure mode is the worst kind: a
 * confidently warped card that looks fine in a thumbnail and is wrong in the one image you
 * kept. Instead, a rotated or skewed shot is *detected* and reported, so the answer is "hold
 * the phone square and take it again" rather than a mangled crop.
 *
 * ## How it finds the card
 *
 * Background subtraction rather than edge detection. Edges are everywhere in a photo — wood
 * grain, a cutting mat, the card's own artwork — and gradient-based bounding boxes latch onto
 * whichever is strongest. But the *background* is knowable: it is whatever is at the border of
 * the frame, because the card is the thing in the middle. So:
 *
 *   1. sample the outer border, take the median colour — median, not mean, so a corner of
 *      something else in shot does not drag the estimate
 *   2. mark every pixel far enough from that colour as foreground
 *   3. take a robust bounding box of the foreground, trimming a small percentile off each
 *      edge so dust and a stray finger do not define the crop
 *   4. sanity-check what came out
 *
 * Step 4 is what makes it safe to run automatically. A trading card is 2.5 × 3.5 inches, so a
 * correct crop has a known aspect ratio, and a correct axis-aligned crop has a foreground that
 * nearly fills its own bounding box. When either check fails the function says so and the UI
 * offers the untouched photo instead.
 */

/** Trading card, 2.5 x 3.5 inches. Every accept/reject decision is relative to this. */
export const CARD_RATIO = 2.5 / 3.5;          // 0.714 (width / height, portrait)

/** How far from the background colour a pixel must be to count as card. 0-255 per channel,
 *  summed over three channels, so 38 is a modest but unambiguous difference. */
const FG_THRESHOLD = 38;

/** Fraction trimmed from each end of the foreground coordinate distribution. Small: the point
 *  is to drop specks, not to shave the card. */
const TRIM = 0.005;

/** Below this, the foreground is not a filled axis-aligned rectangle — the shot is rotated,
 *  or there is more than one object. A rotated rectangle fills at most ~1/(cos+sin) of its
 *  bounding box, which is 0.87 at 15 degrees and 0.71 at 45. */
const MIN_FILL = 0.82;

/** Accepted aspect band. Wide enough for a crop that clipped a little, narrow enough to reject
 *  "I found the whole table" and "I found a sliver". */
const RATIO_MIN = 0.55;
const RATIO_MAX = 0.92;

/**
 * @param {Uint8ClampedArray} data RGBA, length w*h*4
 * @returns {{ box:{x:number,y:number,w:number,h:number}, fill:number, ratio:number,
 *             coverage:number, ok:boolean, reason:string|null, landscape:boolean }}
 */
export function findCard(data, w, h) {
  if (!w || !h || data.length < w * h * 4) {
    return fail({ x: 0, y: 0, w: w || 0, h: h || 0 }, 'that image could not be read');
  }

  const bg = borderColour(data, w, h);

  // Foreground mask, plus the row/column histograms in the same pass.
  const cols = new Int32Array(w);
  const rows = new Int32Array(h);
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
      if (d > FG_THRESHOLD) { cols[x]++; rows[y]++; total++; }
    }
  }

  const whole = { x: 0, y: 0, w, h };
  if (total < w * h * 0.02) {
    /**
     * Almost nothing differs from the border colour. Two very different situations produce
     * this, and background subtraction cannot tell them apart even in principle:
     *
     *   - a photo of a blank surface with no card in it;
     *   - a card that fills the frame, so the card itself IS the border.
     *
     * The second is common — it is what you get from a scan, or from a photo you already
     * cropped. Both resolve to "propose no crop and offer the whole photo", which is correct
     * for the full-frame card and harmless for the blank surface, since the preview shows what
     * is about to be saved. The message names both rather than guessing.
     */
    return fail(whole, 'could not separate a card from the background — it may already fill the '
                     + 'frame, or the surface may be too similar. The whole photo will be used.');
  }

  const [x0, x1] = trimmedSpan(cols, total, w);
  const [y0, y1] = trimmedSpan(rows, total, h);
  const box = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };

  // How much of the box is actually card. A clean straight-on shot is near 1; a rotated card,
  // or a card plus a pen in frame, is markedly less.
  const fill = total / (box.w * box.h);
  const ratio = box.w / box.h;
  const landscape = ratio > 1;
  const shapeRatio = landscape ? 1 / ratio : ratio;
  const coverage = (box.w * box.h) / (w * h);

  if (fill < MIN_FILL) {
    return { box, fill, ratio, coverage, landscape, ok: false,
      reason: 'the card looks rotated or something else is in the shot — lay it square and retake' };
  }
  if (shapeRatio < RATIO_MIN || shapeRatio > RATIO_MAX) {
    return { box, fill, ratio, coverage, landscape, ok: false,
      reason: `that shape is not card-shaped (${shapeRatio.toFixed(2)} against ${CARD_RATIO.toFixed(2)})` };
  }
  if (coverage > 0.985) {
    // Nothing to crop. Not a failure — say so plainly rather than pretending to have worked.
    return { box, fill, ratio, coverage, landscape, ok: true,
      reason: 'already cropped to the card' };
  }

  return { box, fill, ratio, coverage, landscape, ok: true, reason: null };
}

function fail(box, reason) {
  return { box, fill: 0, ratio: box.h ? box.w / box.h : 0, coverage: 1, landscape: false,
           ok: false, reason };
}

/**
 * Median colour of the frame's border.
 *
 * Median rather than mean, and a ring rather than the four corners: a mean is dragged by any
 * bright object clipping an edge, and corners alone are too few samples on a noisy phone
 * photo. The ring is 4% of the shorter side, which is thick enough to be stable and thin
 * enough that a card nearly filling the frame does not contaminate it.
 */
function borderColour(data, w, h) {
  const t = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const r = [], g = [], b = [];
  const take = (x, y) => {
    const i = (y * w + x) * 4;
    r.push(data[i]); g.push(data[i + 1]); b.push(data[i + 2]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < t; x++) take(x, y);
    for (let x = w - t; x < w; x++) take(x, y);
  }
  for (let x = t; x < w - t; x++) {
    for (let y = 0; y < t; y++) take(x, y);
    for (let y = h - t; y < h; y++) take(x, y);
  }
  return [median(r), median(g), median(b)];
}

function median(a) {
  if (!a.length) return 0;
  a.sort((x, y) => x - y);
  return a[a.length >> 1];
}

/**
 * The span of a histogram, ignoring a small percentile at each end.
 *
 * A plain "first non-zero to last non-zero" bounding box is decided by the single most distant
 * speck of dust, which in practice means the crop is the whole photo. Trimming by cumulative
 * mass instead makes the box depend on where the pixels actually are.
 */
function trimmedSpan(hist, total, n) {
  const drop = total * TRIM;
  let acc = 0, lo = 0, hi = n;
  for (let i = 0; i < n; i++) { acc += hist[i]; if (acc >= drop) { lo = i; break; } }
  acc = 0;
  for (let i = n - 1; i >= 0; i--) { acc += hist[i]; if (acc >= drop) { hi = i + 1; break; } }
  if (hi <= lo) return [0, n];
  return [lo, hi];
}

/**
 * Grow a box to the card aspect ratio without moving its centre, then clamp to the image.
 *
 * Always grows, never shrinks: shrinking to hit a ratio crops away part of the card, and a
 * slightly generous border is invisible in a thumbnail while a clipped edge is not. Clamping
 * can leave the result slightly off-ratio, which is correct — the alternative is inventing
 * pixels outside the photograph.
 */
export function snapToCardRatio(box, imgW, imgH, landscape = false) {
  const target = landscape ? 1 / CARD_RATIO : CARD_RATIO;
  let { x, y, w, h } = box;
  const cx = x + w / 2, cy = y + h / 2;
  if (w / h > target) h = w / target; else w = h * target;
  x = cx - w / 2; y = cy - h / 2;

  // Clamp by shifting first, and only then by shrinking, so a box near the edge slides into
  // frame rather than losing the side of the card.
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > imgW) x = Math.max(0, imgW - w);
  if (y + h > imgH) y = Math.max(0, imgH - h);
  w = Math.min(w, imgW - x);
  h = Math.min(h, imgH - y);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** A little air around the card, so a crop that is one pixel tight does not look like a mistake. */
export function padBox(box, imgW, imgH, pct = 0.015) {
  const p = Math.round(Math.min(box.w, box.h) * pct);
  const x = Math.max(0, box.x - p), y = Math.max(0, box.y - p);
  return {
    x, y,
    w: Math.min(imgW - x, box.w + p * 2),
    h: Math.min(imgH - y, box.h + p * 2),
  };
}
