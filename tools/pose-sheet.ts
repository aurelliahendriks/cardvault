import { writeFileSync } from 'node:fs';
import { POSE_NAMES, POSE_LABELS, figureSvg } from '../src/media/poses.js';
const row = (family: 'geometry' | 'traced', w = 200) => POSE_NAMES.map((n) => `
  <figure><svg viewBox="0 0 300 300" width="${w}" height="${w}">
    <rect width="300" height="300" rx="10" fill="#1f4f8f"/>
    ${figureSvg(n, '#ffffff', '#141413', { family })}
  </svg><figcaption>${POSE_LABELS[n]}</figcaption></figure>`).join('');
const cells = row('traced');
const geo = row('geometry', 150);
const stripes = POSE_NAMES.map((n) => `
  <figure><svg viewBox="0 0 300 300" width="150" height="150">
    <rect width="300" height="300" rx="10" fill="#75AADB"/>
    ${Array.from({length:10},(_,i)=>`<rect x="${i*30}" width="15" height="300" fill="#FFFFFF" fill-opacity="0.9"/>`).join('')}
    ${figureSvg(n, '#FFFFFF', '#141413')}
  </svg></figure>`).join('');
const checks = POSE_NAMES.map((n) => {
  const sq:string[]=[]; for(let r=0;r<8;r++)for(let c=0;c<8;c++) if((r+c)%2) sq.push(`<rect x="${c*37.5}" y="${r*37.5}" width="37.5" height="37.5" fill="#FFFFFF" fill-opacity="0.92"/>`);
  return `<figure><svg viewBox="0 0 300 300" width="150" height="150"><rect width="300" height="300" rx="10" fill="#FF0000"/>${sq.join('')}${figureSvg(n,'#FF0000','#141413')}</svg></figure>`;
}).join('');
writeFileSync('/tmp/poses.html', `<html><body style="background:#141413;color:#eee;font:14px system-ui;margin:24px">
<h3>traced from the generated sheet</h3>
<div style="display:flex;flex-wrap:wrap;gap:14px">${cells}</div>
<h3>built-in geometry, for comparison</h3>
<div style="display:flex;flex-wrap:wrap;gap:10px">${geo}</div>
<h3>over Argentina stripes</h3><div style="display:flex;gap:10px">${stripes}</div>
<h3>over Croatia checks</h3><div style="display:flex;gap:10px">${checks}</div>
<style>figure{margin:0;text-align:center}figcaption{font-size:12px;opacity:.7;margin-top:4px}</style>
</body></html>`);
console.log('ok');
