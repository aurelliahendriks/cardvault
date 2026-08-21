/** Do the inlined avatars still animate inside the single-file preview? */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });

async function frames(reduced) {
  const p = await b.newPage({ viewport: { width: 1400, height: 900 },
    reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await p.goto('file:///home/claude/cardvault/cardvault-preview.html', { waitUntil: 'load' });
  await p.waitForTimeout(2600);
  const grid = p.locator('#pgal');
  const a = await grid.screenshot();
  await p.waitForTimeout(800);
  const c = await grid.screenshot({ path: reduced ? undefined : '/tmp/shots/pv-motion.png' });
  const srcs = await p.locator('.pcard img').evaluateAll((els) => els.map((e) => e.getAttribute('src') || ''));
  await p.close();
  const h = (x) => createHash('sha1').update(x).digest('hex').slice(0, 8);
  return { moved: h(a) !== h(c), tiles: srcs.length,
           dataUris: srcs.filter((s) => s.startsWith('data:')).length };
}
const normal = await frames(false);
console.log(`preview: ${normal.tiles} tiles, ${normal.dataUris} inlined — animating: ${normal.moved}`);
const reduced = await frames(true);
console.log(`under reduced motion — animating: ${reduced.moved} (should be false)`);
await b.close();
