#!/usr/bin/env python3
"""
Measure whether the rarity ladder actually reads as a ladder.

The question is not "does each tier look different" — that is easy and not the point.
It is "can someone perceive *increasing* scarcity without reading the serial number",
which means the visual intensity has to be monotonic in rarity, and it has to stay
monotonic when colour is removed. A ladder that only ascends in hue is invisible to a
deuteranope and unreadable in a greyscale print of your own listing photos.

Three measures per step, all against the base tile as the zero point:

  dL    mean absolute luminance change — "how much the picture changed"
  chroma  Hasler-Süsstrunk colourfulness — the colour channel on its own
  edge  mean gradient magnitude — structural cues: fracture lines, glow edges, rims

Score is deliberately luminance-and-structure weighted, with colour worth least, so a
tier cannot pass on hue alone. The greyscale check then re-runs the same test with
chroma set to zero.
"""
import json
import math
import sys
import warnings

warnings.filterwarnings('ignore', category=DeprecationWarning)

from PIL import Image, ImageFilter


def stats(path):
    im = Image.open(path).convert('RGB')
    # Downscale slightly: measuring at capture resolution rewards single-pixel noise.
    im = im.resize((im.width // 2 or 1, im.height // 2 or 1), Image.LANCZOS)
    px = list(im.getdata())  # noqa: PIL deprecation is fine for a tool
    n = len(px)

    lum = [0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in px]
    mean_l = sum(lum) / n

    # Hasler-Süsstrunk colourfulness.
    rg = [r - g for r, g, b in px]
    yb = [0.5 * (r + g) - b for r, g, b in px]

    def ms(v):
        m = sum(v) / len(v)
        sd = math.sqrt(sum((x - m) ** 2 for x in v) / len(v))
        return m, sd

    m_rg, sd_rg = ms(rg)
    m_yb, sd_yb = ms(yb)
    chroma = math.sqrt(sd_rg ** 2 + sd_yb ** 2) + 0.3 * math.sqrt(m_rg ** 2 + m_yb ** 2)

    # Structure: gradient magnitude on the luminance channel.
    grey = im.convert('L')
    edges = grey.filter(ImageFilter.FIND_EDGES)
    ep = list(edges.getdata())
    edge = sum(ep) / len(ep)

    return {'mean_l': mean_l, 'chroma': chroma, 'edge': edge, 'lum': lum}


def flat_check(measured, tol):
    """With effects off every step must look the SAME. Asserting flatness is the real
    test here — running the monotonic check on near-identical tiles just amplifies
    compression noise into imaginary ordering."""
    worst = max(measured, key=lambda m: m['dL'])
    print(f"  largest difference from base: {worst['dL']:.3f} ({worst['step']})")
    if worst['dL'] > tol:
        print(f"\n  FAIL — effects are still visible with the switch off "
              f"({worst['dL']:.3f} > {tol})")
        return 1
    print(f"\n  PASS — every step renders identically (all within {tol} of base)")
    return 0


GRADED_SUFFIX = ' + PSA 10'


def graded_check(measured):
    """Grading must be additive, and small.

    A PSA 10 /99 is still one of 99 copies: condition scarcity is a different axis from
    print scarcity, so the grade layer has to leave the rung ordering untouched. Two
    assertions, and the first one is the one that caught a real bug — the slab glass was
    replacing the sweep with !important, so graded cards at high rungs measured *below*
    their raw twins.

      1. every graded rung >= its raw twin      (glass adds, never subtracts)
      2. the grade delta stays under one rung   (condition never outranks scarcity)
    """
    raw = {m['step']: m for m in measured if not m['step'].endswith(GRADED_SUFFIX)}
    graded = {m['step'][:-len(GRADED_SUFFIX)]: m for m in measured
              if m['step'].endswith(GRADED_SUFFIX)}
    pairs = [(k, raw[k], graded[k]) for k in raw if k in graded]
    pairs.sort(key=lambda t: t[1]['rank'])

    print(f"  {'step':<14}{'raw':>8}{'graded':>8}{'delta':>8}   verdict")
    fails = []
    # The smallest gap between adjacent RUNGS is the budget the grade layer must fit
    # inside. Rungs, not rows: 'Parallel' and 'Gold parallel' share a rank, so the gap
    # between those two flavours is noise and using it as the budget made every card
    # fail for adding more than 1.1.
    ladder = [p for p in pairs if not p[0].startswith('PSA')]
    by_rank = {}
    for step, r, g in ladder:
        by_rank[r['rank']] = max(by_rank.get(r['rank'], 0.0), r['score'])
    rungs = [by_rank[k] for k in sorted(by_rank)]
    steps = [rungs[i] - rungs[i - 1] for i in range(1, len(rungs))]
    budget = min([s for s in steps if s > 0.5] or [MIN_STEP])

    # The precise statement of "condition must not outrank scarcity": grading a card
    # must never push it past the next rung up. A graded /199 has to still read below a
    # raw /99. Comparing the delta to the smallest gap anywhere on the ladder was too
    # blunt — the bottom two rungs are close together by design.
    ranks = sorted(by_rank)
    next_rung = {ranks[i]: by_rank[ranks[i + 1]] for i in range(len(ranks) - 1)}

    for step, r, g in pairs:
        d = g['score'] - r['score']
        ceiling = next_rung.get(r['rank'])
        verdict = 'ok'
        if d < -0.5:
            verdict = 'GRADE WEAKENS THE RUNG'
            fails.append(f"{step}: grading made it weaker ({d:+.1f}) — the grade layer "
                         f"is replacing a rarity cue instead of adding to it")
        elif ceiling is not None and g['score'] >= ceiling and not step.startswith('PSA'):
            verdict = f'PASSES THE NEXT RUNG ({ceiling:.1f})'
            fails.append(f"{step} + PSA 10 scores {g['score']:.1f}, at or above the raw "
                         f"rung above it ({ceiling:.1f}) — condition is outranking scarcity")
        print(f"  {step:<14}{r['score']:>8.1f}{g['score']:>8.1f}{d:>+8.1f}   {verdict}")

    # And the graded ladder has to still be a ladder.
    prev = None
    for step, _r, g in ladder:
        if prev is not None and g['score'] <= prev:
            fails.append(f"{step} + PSA 10 is not stronger than the graded rung below it")
        prev = g['score']

    if fails:
        print('\n  FAIL')
        for f in fails:
            print('   -', f)
        return 1
    print(f"\n  PASS — grading is additive on all {len(pairs)} rungs, never reaches the "
          f"rung above (tightest headroom {budget:.1f}), ordering preserved")
    return 0


def main(manifest_path):
    man = json.load(open(manifest_path))
    rows = man['rows']
    measured = [dict(r, **stats(r['file'])) for r in rows]

    base = next(m for m in measured if m['tier'] == 'base')
    # Copy before the loop: base is measured too, and deleting its pixels mid-loop
    # leaves every later step comparing against nothing.
    base_lum = list(base['lum'])

    for m in measured:
        # dL against base, computed per-pixel then averaged, so a bright patch and an
        # equally dark patch do not cancel to "no change".
        m['dL'] = sum(abs(a - b) for a, b in zip(m['lum'], base_lum)) / len(m['lum'])
        m['dChroma'] = max(0.0, m['chroma'] - base['chroma'])
        m['dEdge'] = max(0.0, m['edge'] - base['edge'])
        del m['lum']

    # Normalise each measure to its own max so the weights mean what they say.
    def norm(key):
        top = max(m[key] for m in measured) or 1.0
        for m in measured:
            m['n_' + key] = m[key] / top

    for k in ('dL', 'dChroma', 'dEdge'):
        norm(k)

    for m in measured:
        m['score'] = 100 * (0.45 * m['n_dL'] + 0.20 * m['n_dChroma'] + 0.35 * m['n_dEdge'])
        # Colour removed entirely: the test a colour-blind user is really running.
        m['score_grey'] = 100 * (0.56 * m['n_dL'] + 0.44 * m['n_dEdge'])

    if man['mode'] == 'off':
        return flat_check(measured, FLAT_TOL)

    if man['mode'] == 'graded':
        return graded_check(measured)

    graded = [m for m in measured if m['step'].startswith('PSA')]
    ladder = sorted([m for m in measured if not m['step'].startswith('PSA')],
                    key=lambda m: (m['rank'], m['step']))

    print(f"  size={man['size']}  mode={man['mode']}")
    print(f"  {'step':<14}{'tier':<10}{'dL':>7}{'chroma':>8}{'edge':>7}{'score':>8}{'grey':>8}  step-up")
    prev = prev_g = prev_rank = None
    fails = []
    for m in ladder:
        same_rung = prev_rank is not None and m['rank'] == prev_rank
        up = '' if prev is None else ('=' if same_rung else f"+{m['score'] - prev:.1f}")
        print(f"  {m['step']:<14}{m['tier']:<10}{m['dL']:>7.2f}{m['dChroma']:>8.2f}"
              f"{m['dEdge']:>7.2f}{m['score']:>8.1f}{m['score_grey']:>8.1f}  {up}")
        if prev is not None and same_rung:
            # Equal rank means "same rung, different flavour" — an unnumbered Gold is
            # not scarcer than an unnumbered Purple. These must measure ALIKE, and a
            # gap here is the bug that made gold outrank /99.
            if abs(m['score'] - prev) > SAME_RUNG_TOL:
                fails.append(f"{m['step']} and the flavour beside it differ by "
                             f"{abs(m['score'] - prev):.1f} but share a rung "
                             f"(tolerance {SAME_RUNG_TOL}) — one will read as rarer")
        elif prev is not None:
            if m['score'] <= prev:
                fails.append(f"{m['step']} is not stronger than the step below it "
                             f"({m['score']:.1f} <= {prev:.1f})")
            elif m['score'] - prev < MIN_STEP:
                fails.append(f"{m['step']} is only +{m['score'] - prev:.1f} over the step "
                             f"below (need +{MIN_STEP})")
            if m['score_grey'] <= prev_g:
                fails.append(f"{m['step']} does not rise in greyscale "
                             f"({m['score_grey']:.1f} <= {prev_g:.1f}) — colour is doing all the work")
        if not same_rung or prev is None:
            prev, prev_g = m['score'], m['score_grey']
        else:
            prev, prev_g = max(prev, m['score']), max(prev_g, m['score_grey'])
        prev_rank = m['rank']

    for m in graded:
        print(f"  {m['step']:<14}{m['tier']:<10}{m['dL']:>7.2f}{m['dChroma']:>8.2f}"
              f"{m['dEdge']:>7.2f}{m['score']:>8.1f}{m['score_grey']:>8.1f}  (not on the ladder)")

    if fails:
        print('\n  FAIL')
        for f in fails:
            print('   -', f)
        return 1
    print(f"\n  PASS — {len(ladder)} steps, monotonic in both colour and greyscale")
    return 0


MIN_STEP = float(sys.argv[2]) if len(sys.argv) > 2 else 3.0
SAME_RUNG_TOL = float(sys.argv[3]) if len(sys.argv) > 3 else 6.0
FLAT_TOL = 1.0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
