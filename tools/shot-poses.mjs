import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1760, height: 1700 } });
await p.goto('file:///tmp/poses.html');
await p.waitForTimeout(500);
await p.screenshot({ path: '/tmp/shots/poses.png', fullPage: true });
await b.close();
