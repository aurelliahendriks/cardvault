/**
 * Export one picture per player, as a pack.
 *
 * This is the deliverable people actually mean by "a zip of pictures for each player":
 * 783 files, one per name on the checklist, each visibly different. It is generated art,
 * so there is no licence to track and no likeness to get wrong — and where a real
 * photograph exists it is used instead, with its credit written into CREDITS.txt.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { q } from '../src/db.js';
import { avatarSvg } from '../src/media/images.js';
import { portraitDataUri } from '../src/media/players.js';
import { resolvePose } from '../src/media/images.js';

const OUT = process.argv[2] ?? '/tmp/player-pack';
const LIMIT = Number(process.argv[3] ?? 2000);

const players = await q<{
  name: string; team: string | null; position: string | null; pose: string | null;
  hot: boolean; club: string | null; author: string | null; license: string | null;
  license_url: string | null; credit_url: string | null; has_portrait: boolean;
}>(
  `SELECT p.name, p.position, p.pose_override AS pose, p.club,
          p.author, p.license, p.license_url, p.credit_url,
          (p.portrait_path IS NOT NULL) AS has_portrait,
          (SELECT MIN(team) FROM cards c WHERE c.player = p.name) AS team,
          COALESCE((SELECT BOOL_OR(hot) FROM cards c WHERE c.player = p.name), false) AS hot
     FROM players p
    WHERE EXISTS (SELECT 1 FROM cards c WHERE c.player = p.name)
    ORDER BY p.name LIMIT $1`, [LIMIT]);

const kits = new Map<string, any>();
for (const k of await q<any>(`SELECT * FROM nation_kits`)) kits.set(k.team, k);

await mkdir(join(OUT, 'svg'), { recursive: true });
// Only strip what Windows actually forbids. The first version replaced every non-ASCII
// character, which turned Aïssa Mandi into "A_ssa Mandi" — mangling people's names in a
// file listing is not an acceptable cost for filename safety.
const safe = (n: string) => n.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim();

const credits: string[] = [];
const index: string[] = [];
let photos = 0;

for (const p of players) {
  const portrait = p.has_portrait ? await portraitDataUri(p.name).catch(() => null) : null;
  if (portrait) photos++;
  const svg = avatarSvg({
    player: p.name, team: p.team, kit: kits.get(p.team ?? '') ?? null,
    position: p.position, pose: p.pose, portraitDataUri: portrait,
    iconic: p.hot || /messi|ronaldo/i.test(p.name),
  });
  const file = `${safe(p.name)}.svg`;
  await writeFile(join(OUT, 'svg', file), svg);

  index.push(`<figure><img src="svg/${encodeURIComponent(file)}" width="150" height="150" loading="lazy">`
    + `<figcaption>${p.name}<br><span>${[p.team, p.position, p.club].filter(Boolean).join(' · ')}</span>`
    + `</figcaption></figure>`);

  credits.push(portrait
    ? `${p.name}\n  photograph — ${p.author ?? 'unknown author'} · ${p.license ?? 'licence unrecorded'}`
      + `${p.license_url ? ' · ' + p.license_url : ''}${p.credit_url ? '\n  source: ' + p.credit_url : ''}`
    : `${p.name}\n  generated art — CardVault, anonymous figure, no likeness, no third-party rights`
      + `\n  pose: ${resolvePose(p.pose, p.position)} · kit: ${p.team ?? 'unknown'}`);
}

await writeFile(join(OUT, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>CardVault player pack</title>
<style>body{background:#141413;color:#e8e6e3;font:14px system-ui;margin:20px}
h1{font-size:19px}p{color:#a3a3a0;max-width:60em}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-top:16px}
figure{margin:0}img{display:block;border-radius:8px;width:100%;height:auto}
figcaption{font-size:11.5px;margin-top:5px;line-height:1.35}
figcaption span{color:#8f8f8c}</style>
<h1>CardVault — one picture per player (${players.length})</h1>
<p>${photos} real photographs (credited in CREDITS.txt), ${players.length - photos} generated
figures. The generated art is anonymous — kit colours, a position-appropriate pose and
per-player staging — and carries no likeness of any real person, which is why it needs no
licence. Photographs come from Wikimedia Commons and <b>do</b> require the attribution in
CREDITS.txt wherever you republish them.</p>
<div class="g">${index.join('')}</div>`);

await writeFile(join(OUT, 'CREDITS.txt'),
  `CardVault player pack\n${'='.repeat(60)}\n\n`
  + `${players.length} players. ${photos} photographs, ${players.length - photos} generated figures.\n\n`
  + `PHOTOGRAPHS carry the licence and author shown below and must keep that attribution\n`
  + `wherever you republish them. GENERATED FIGURES are anonymous art with no likeness of\n`
  + `any real person: no attribution required, and no third-party rights attached.\n\n`
  + `${'='.repeat(60)}\n\n${credits.join('\n\n')}\n`);

console.log(`${players.length} players → ${OUT} (${photos} photographs, ${players.length - photos} generated)`);
process.exit(0);
