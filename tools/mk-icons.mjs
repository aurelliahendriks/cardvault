import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
for (const [size, out, pad] of [[192,'icon-192.png',0],[512,'icon-512.png',0],[180,'apple-touch-icon.png',0],[512,'icon-maskable-512.png',1]]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  // Maskable icons are cropped to a circle by Android, so the art must sit inside the safe
  // zone (80% of the canvas) or the corners of the cards get shaved off.
  await p.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;background:#0d0d0d;
    display:flex;align-items:center;justify-content:center;overflow:hidden">
    <div style="width:${pad?size*0.78:size}px;height:${pad?size*0.78:size}px">
    ${(await (await import('node:fs/promises')).readFile('/tmp/icon.html','utf8')).replace(/<\/?html>|<\/?body[^>]*>/g,'')
      .replace('width="512" height="512"', `width="100%" height="100%"`)}
    </div></body></html>`);
  await p.waitForTimeout(150);
  await p.screenshot({ path: `web/${out}`, omitBackground: false });
  console.log(out, size);
  await p.close();
}
await b.close();
