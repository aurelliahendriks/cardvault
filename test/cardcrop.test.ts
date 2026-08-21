import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_RATIO, findCard, padBox, snapToCardRatio } from '../web/cardcrop.js';

/**
 * Synthetic photographs. Pixel-exact fixtures rather than real images on purpose: a real photo
 * tests the algorithm and the JPEG encoder and the lighting all at once, so when it fails you
 * learn nothing. These isolate the one thing under test — can it find a rectangle that differs
 * from the border colour, and does it refuse when it should.
 */
function canvas(w: number, h: number, bg: [number, number, number]) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = bg[0]; d[i * 4 + 1] = bg[1]; d[i * 4 + 2] = bg[2]; d[i * 4 + 3] = 255;
  }
  return d;
}

function rect(d: Uint8ClampedArray, w: number, box: { x: number; y: number; w: number; h: number },
              c: [number, number, number]) {
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = (y * w + x) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
    }
  }
}

/** A rotated filled rectangle, for the "hold it square" case. */
function rotatedRect(d: Uint8ClampedArray, w: number, h: number, cx: number, cy: number,
                     rw: number, rh: number, deg: number, c: [number, number, number]) {
  const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
      if (Math.abs(u) <= rw / 2 && Math.abs(v) <= rh / 2) {
        const i = (y * w + x) * 4;
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
      }
    }
  }
}

const W = 400, H = 500;
const MAT: [number, number, number] = [30, 30, 32];      // a dark cutting mat
const CARD: [number, number, number] = [230, 225, 215];  // a pale card

test('finds a card lying square on a contrasting mat', () => {
  const d = canvas(W, H, MAT);
  const truth = { x: 90, y: 90, w: 200, h: 280 };        // 0.714, card-shaped
  rect(d, W, truth, CARD);

  const r = findCard(d, W, H);
  assert.equal(r.ok, true, r.reason ?? '');
  // Within a couple of pixels: the trimmed span drops half a percent of mass at each edge, so
  // exactness is neither expected nor wanted.
  for (const k of ['x', 'y', 'w', 'h'] as const) {
    assert.ok(Math.abs(r.box[k] - truth[k]) <= 3,
      `${k}: got ${r.box[k]}, expected about ${truth[k]}`);
  }
  assert.ok(r.fill > 0.98, `a solid rectangle should nearly fill its box (fill=${r.fill.toFixed(3)})`);
});

test('a rotated card is refused rather than cropped badly', () => {
  // This is the case that matters most. A confidently wrong crop is worse than no crop,
  // because the mangled image is the one you keep.
  const d = canvas(W, H, MAT);
  rotatedRect(d, W, H, 200, 250, 200, 280, 20, CARD);

  const r = findCard(d, W, H);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /rotated/i);
  assert.ok(r.fill < 0.82, `fill should reveal the rotation (fill=${r.fill.toFixed(3)})`);
});

test('a photo of nothing but background is refused', () => {
  const r = findCard(canvas(W, H, MAT), W, H);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /background/i);
});

test('something the wrong shape is refused', () => {
  const d = canvas(W, H, MAT);
  rect(d, W, { x: 40, y: 220, w: 320, h: 60 }, CARD);     // a pen, or a label
  const r = findCard(d, W, H);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /card-shaped/i);
});

test('a card filling the frame proposes no crop, and says why honestly', () => {
  // The card is the border, so background subtraction has nothing to subtract. This is not a
  // solvable case — a blank mat produces byte-identical input — so the honest outcome is "no
  // crop, use the whole photo", not a guess. Asserted because an earlier version claimed
  // "no card stood out", which reads as a failure when in fact the card is all there is.
  const d = canvas(W, H, MAT);
  rect(d, W, { x: 1, y: 1, w: W - 2, h: H - 2 }, CARD);
  const r = findCard(d, W, H);
  assert.equal(r.ok, false, 'no crop is proposed');
  assert.match(r.reason ?? '', /already fill the frame/i);
  assert.deepEqual(r.box, { x: 0, y: 0, w: W, h: H }, 'and the fallback box is the whole photo');
});

test('a light card on a light background is still found', () => {
  // The threshold has to work on a white card on a pale desk, which is the common bad case —
  // people photograph cards on whatever is in front of them.
  const d = canvas(W, H, [235, 233, 228]);
  const truth = { x: 100, y: 100, w: 200, h: 280 };
  rect(d, W, truth, [188, 190, 196]);                    // grey-blue, ~45 total difference
  const r = findCard(d, W, H);
  assert.equal(r.ok, true, r.reason ?? '');
  assert.ok(Math.abs(r.box.x - truth.x) <= 4 && Math.abs(r.box.w - truth.w) <= 6,
    `box was ${JSON.stringify(r.box)}`);
});

test('dust does not decide the crop', () => {
  const d = canvas(W, H, MAT);
  const truth = { x: 90, y: 90, w: 200, h: 280 };
  rect(d, W, truth, CARD);
  // A speck in the corner. A first-non-zero-to-last-non-zero bounding box would return the
  // whole frame; the trimmed span must ignore it.
  rect(d, W, { x: 2, y: 2, w: 3, h: 3 }, [255, 255, 255]);
  const r = findCard(d, W, H);
  assert.equal(r.ok, true, r.reason ?? '');
  assert.ok(r.box.x > 60, `the speck pulled the box to x=${r.box.x}`);
});

test('snapping to the card ratio grows, never shrinks', () => {
  const box = { x: 100, y: 100, w: 200, h: 200 };         // square, too wide for a card
  const snapped = snapToCardRatio(box, 1000, 1000);
  assert.ok(snapped.h >= box.h, 'height grew');
  assert.equal(snapped.w, box.w, 'width was already the constraint, so it is unchanged');
  assert.ok(Math.abs(snapped.w / snapped.h - CARD_RATIO) < 0.02,
    `ratio is ${(snapped.w / snapped.h).toFixed(3)}`);
});

test('snapping keeps the box inside the photo', () => {
  // Near the top edge: it must slide down into frame rather than crop the top off the card.
  const snapped = snapToCardRatio({ x: 5, y: 2, w: 300, h: 200 }, 400, 500);
  assert.ok(snapped.x >= 0 && snapped.y >= 0);
  assert.ok(snapped.x + snapped.w <= 400 && snapped.y + snapped.h <= 500);
});

test('snapping cannot invent pixels outside a small photo', () => {
  const snapped = snapToCardRatio({ x: 0, y: 0, w: 100, h: 100 }, 100, 100);
  assert.ok(snapped.w <= 100 && snapped.h <= 100);
  assert.ok(snapped.x + snapped.w <= 100 && snapped.y + snapped.h <= 100);
});

test('padding stays inside the photo', () => {
  const p = padBox({ x: 0, y: 0, w: 400, h: 500 }, 400, 500);
  assert.deepEqual(p, { x: 0, y: 0, w: 400, h: 500 });
  const q = padBox({ x: 50, y: 50, w: 100, h: 140 }, 400, 500);
  assert.ok(q.x < 50 && q.y < 50 && q.w > 100 && q.h > 140);
  assert.ok(q.x + q.w <= 400 && q.y + q.h <= 500);
});

test('a zero-sized image does not throw', () => {
  const r = findCard(new Uint8ClampedArray(0), 0, 0);
  assert.equal(r.ok, false);
});
