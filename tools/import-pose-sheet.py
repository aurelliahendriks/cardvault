#!/usr/bin/env python3
"""
Turn a generated pose sheet into usable assets.

Slicing on a fixed 4x2 grid does not survive contact with a real generated sheet: the
cells are never evenly spaced, figure heights vary by 30%, and a ball drawn beside a foot
lands in the neighbouring cell. So this finds connected components in the alpha channel
instead, groups a ball with the figure it belongs to, sorts them into reading order, and
normalises each one into the same 300x300 box the app's own poses use.

Two outputs per pose:
  web/assets/poses/<name>.png   PNG-8, alpha, for anyone who wants the raster
  src/media/poses-art.ts        traced SVG paths, which is what the app actually uses

The traced path is the useful artefact: about 2-4 KB, scales to any tile size, and takes
its colour from the same two-pass ink/rim treatment as the built-in geometry, so a
generated figure sits on Croatia's checks as legibly as a hand-authored one.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

# Reading order of the sheet, matching src/media/poses.ts exactly so raster and vector
# stay interchangeable per player.
POSES = ['standing', 'walking', 'running', 'striking',
         'celebrating', 'sliding', 'diving', 'heading']

BOX = 300           # the app's avatar viewBox
TOP, BOTTOM = 30, 250   # the band poses must stay inside; below 250 a caption covers it
MIN_PX = 400        # smaller components are compression noise, not limbs
BALL_MAX_PX = 9000  # a component this small next to a figure is a ball


def components(alpha: np.ndarray):
    """Label opaque blobs, largest first, with bounding boxes."""
    mask = alpha > 96
    lab, n = ndimage.label(mask)
    out = []
    for i in range(1, n + 1):
        ys, xs = np.where(lab == i)
        if len(ys) < MIN_PX:
            continue
        out.append({
            'id': i, 'px': int(len(ys)),
            'x0': int(xs.min()), 'x1': int(xs.max()),
            'y0': int(ys.min()), 'y1': int(ys.max()),
        })
    return lab, sorted(out, key=lambda c: -c['px'])


def merge_balls(comps):
    """
    Attach small components to the figure they belong to.

    A ball beside a boot is a separate blob, and cropping it away loses the whole point
    of the 'striking' and 'heading' poses. Nearest-figure by centre distance, and only
    when the small blob is genuinely small.
    """
    figures = [c for c in comps if c['px'] > BALL_MAX_PX]
    smalls = [c for c in comps if c['px'] <= BALL_MAX_PX]
    for f in figures:
        f['parts'] = [f]
    for s in smalls:
        cx, cy = (s['x0'] + s['x1']) / 2, (s['y0'] + s['y1']) / 2
        best, bestd = None, 1e18
        for f in figures:
            fx, fy = (f['x0'] + f['x1']) / 2, (f['y0'] + f['y1']) / 2
            d = (cx - fx) ** 2 + (cy - fy) ** 2
            if d < bestd:
                best, bestd = f, d
        if best is not None:
            best['parts'].append(s)
    for f in figures:
        f['bx0'] = min(p['x0'] for p in f['parts'])
        f['bx1'] = max(p['x1'] for p in f['parts'])
        f['by0'] = min(p['y0'] for p in f['parts'])
        f['by1'] = max(p['y1'] for p in f['parts'])
    return figures


def reading_order(figures, height):
    """Top row left-to-right, then bottom row. Rows split at the vertical midpoint."""
    mid = height / 2
    top = sorted([f for f in figures if (f['by0'] + f['by1']) / 2 < mid], key=lambda f: f['bx0'])
    bot = sorted([f for f in figures if (f['by0'] + f['by1']) / 2 >= mid], key=lambda f: f['bx0'])
    return top + bot


def normalise(im: Image.Image, lab, fig) -> Image.Image:
    """Crop to the figure's own pixels, then letterbox into the app's 300x300 band."""
    ids = {p['id'] for p in fig['parts']}
    keep = np.isin(lab, list(ids))
    a = np.asarray(im.getchannel('A'))
    masked = np.where(keep, a, 0).astype(np.uint8)
    rgba = np.dstack([np.full_like(masked, 255)] * 3 + [masked])
    cut = Image.fromarray(rgba, 'RGBA').crop((fig['bx0'], fig['by0'], fig['bx1'] + 1, fig['by1'] + 1))

    band = BOTTOM - TOP
    scale = min(band / cut.height, (BOX - 40) / cut.width)
    w, h = max(1, round(cut.width * scale)), max(1, round(cut.height * scale))
    cut = cut.resize((w, h), Image.LANCZOS)

    canvas = Image.new('RGBA', (BOX, BOX), (255, 255, 255, 0))
    canvas.paste(cut, ((BOX - w) // 2, TOP + (band - h) // 2), cut)
    return canvas


def trace(png: Path, out_svg: Path) -> str:
    """potrace wants a bitmap; feed it the alpha channel as PBM and take the path back."""
    im = Image.open(png).convert('RGBA')
    a = np.asarray(im.getchannel('A'))
    # potrace traces black-on-white, so invert: figure = black.
    bw = Image.fromarray(np.where(a > 96, 0, 255).astype(np.uint8), 'L').convert('1')
    pbm = png.with_suffix('.pbm')
    bw.save(pbm)
    subprocess.run(['potrace', '-s', '-o', str(out_svg), '--flat',
                    '-W', f'{BOX}pt', '-H', f'{BOX}pt', str(pbm)], check=True)
    pbm.unlink(missing_ok=True)

    svg = out_svg.read_text()
    # Pull out just the path data and the transform potrace applied, so the app can drop
    # it into its own viewBox without inheriting potrace's page setup.
    import re
    g = re.search(r'<g([^>]*)>\s*<path([^>]*)d="([^"]+)"', svg, re.S)
    if not g:
        raise SystemExit(f'could not parse potrace output for {png.name}')
    transform = re.search(r'transform="([^"]+)"', g.group(1) or '')
    return json.dumps({'d': g.group(3).strip(), 'transform': transform.group(1) if transform else ''})


def main(src: str):
    im = Image.open(src).convert('RGBA')
    alpha = np.asarray(im.getchannel('A'))
    lab, comps = components(alpha)
    figures = merge_balls(comps)
    ordered = reading_order(figures, im.height)

    print(f'{len(comps)} components -> {len(figures)} figures')
    if len(ordered) != len(POSES):
        print(f'  WARNING: expected {len(POSES)} figures, found {len(ordered)}. '
              f'Mapping in reading order anyway; check the contact sheet.')

    out_png = Path('web/assets/poses'); out_png.mkdir(parents=True, exist_ok=True)
    out_svg = Path('/tmp/pose-svg'); out_svg.mkdir(parents=True, exist_ok=True)
    entries = {}

    for name, fig in zip(POSES, ordered):
        canvas = normalise(im, lab, fig)
        png = out_png / f'{name}.png'
        canvas.save(png)
        subprocess.run(['pngquant', '--quality=55-90', '--speed', '1', '--force',
                        '--output', str(png), str(png)], check=False)
        traced = trace(png, out_svg / f'{name}.svg')
        entries[name] = json.loads(traced)
        print(f'  {name:<12} {fig["px"]:>7} px  parts={len(fig["parts"])}  '
              f'png={png.stat().st_size / 1024:.1f} KB  '
              f'path={len(entries[name]["d"]) / 1024:.1f} KB')

    Path('/tmp/poses-art.json').write_text(json.dumps(entries, indent=1))
    print('wrote /tmp/poses-art.json')


if __name__ == '__main__':
    main(sys.argv[1])
