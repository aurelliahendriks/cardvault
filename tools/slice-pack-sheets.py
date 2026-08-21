#!/usr/bin/env python3
"""Slice the rendered sheets back into one PNG per player."""
import json
import sys
from pathlib import Path

from PIL import Image

man = json.load(open('/tmp/pack-sheets/manifest.json'))
cell, cols = man['cell'], man['cols']
out = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/player-pack') / 'png'
out.mkdir(parents=True, exist_ok=True)

n = 0
for page in man['manifest']:
    sheet = Image.open(page['sheet'])
    for i, name in enumerate(page['batch']):
        x, y = (i % cols) * cell, (i // cols) * cell
        tile = sheet.crop((x, y, x + cell, y + cell))
        tile.save(out / (name[:-4] + '.png'), optimize=True)
        n += 1
print(f'{n} PNGs -> {out}')
