/** How different do tiles actually look, player to player? Counted, not eyeballed. */
import { avatarStyle } from '../src/media/avatarStyle.js';
import { q } from '../src/db.js';

const rows = await q<{ name: string; team: string | null; hot: boolean }>(
  `SELECT p.name, (SELECT MIN(team) FROM cards c WHERE c.player = p.name) AS team,
          COALESCE((SELECT BOOL_OR(hot) FROM cards c WHERE c.player = p.name), false) AS hot
     FROM players p WHERE EXISTS (SELECT 1 FROM cards c WHERE c.player = p.name)`);

const combos = new Set<string>();
const backdrops = new Map<string, number>();
for (const r of rows) {
  const s = avatarStyle(r.name, { iconic: r.hot });
  combos.add([s.backdrop, s.accent, s.mirror, s.scale.toFixed(2)].join('|'));
  backdrops.set(s.backdrop, (backdrops.get(s.backdrop) ?? 0) + 1);
}
console.log(`players: ${rows.length}`);
console.log(`distinct staging combinations: ${combos.size}`);
console.log('backdrop spread:', [...backdrops.entries()].map(([k, v]) => `${k}=${v}`).join(' '));

// Within one nation and one position the tiles used to be identical. Check the worst case.
const byGroup = new Map<string, Set<string>>();
for (const r of rows) {
  const s = avatarStyle(r.name, { iconic: r.hot });
  const key = r.team ?? '?';
  const set = byGroup.get(key) ?? byGroup.set(key, new Set()).get(key)!;
  set.add([s.backdrop, s.accent, s.mirror].join('|'));
}
const worst = [...byGroup.entries()]
  .map(([team, set]) => ({ team, distinct: set.size, players: rows.filter((r) => (r.team ?? '?') === team).length }))
  .filter((x) => x.players >= 8)
  .sort((a, b) => a.distinct / a.players - b.distinct / b.players)
  .slice(0, 5);
console.log('least varied nations (distinct staging / players):');
for (const w of worst) console.log(`  ${w.team.padEnd(20)} ${w.distinct}/${w.players}`);

// Stability: the same name must always give the same tile.
const a = avatarStyle('Lamine Yamal'), b = avatarStyle('Lamine Yamal');
console.log('stable across calls:', JSON.stringify(a) === JSON.stringify(b));
process.exit(0);
