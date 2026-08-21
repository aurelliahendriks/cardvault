import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rarityTier } from '../src/valuation/scores.js';

/**
 * The band boundaries exist twice: once in TypeScript for the API and the scores, once
 * in the dashboard's inline JavaScript so a tile can pick its effect class without
 * making a request. Two copies of a rule drift, and the symptom — a card that looks
 * rarer than it scores — is the kind of bug nobody reports and everybody distrusts.
 *
 * So this test lifts the browser copy straight out of web/index.html, runs it, and
 * compares it to the TypeScript one across every boundary and either side of it.
 */
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

function extractBrowserTier(): (c: any) => string {
  const start = html.indexOf('function rarityTier(c) {');
  assert.notEqual(start, -1, 'could not find rarityTier() in web/index.html');
  // Walk braces to find the end of the function rather than regexing it.
  let depth = 0, i = html.indexOf('{', start);
  const from = i;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  const body = html.slice(from + 1, i);
  return new Function('c', body) as (c: any) => string;
}

const browserTier = extractBrowserTier();

/** The browser names two flavours at the same rung; the TS side names the rung. */
const NORMALISE: Record<string, string> = { silver: 'parallel', gold: 'parallel' };
const norm = (t: string) => NORMALISE[t] ?? t;

test('the browser and the API agree on every band boundary', () => {
  const runs = [null, 1, 2, 3, 5, 9, 10, 11, 12, 24, 25, 26, 27, 48, 49, 50,
                51, 98, 99, 100, 101, 149, 150, 199, 200, 399, 400, 5000];
  for (const print_run of runs) {
    for (const parallel_name of [null, 'Gold', 'Purple']) {
      for (const card_type of [null, 'Base', 'Base Optic', 'Insert', 'Autograph', 'Promo']) {
        const card = { print_run, parallel_name, card_type };
        assert.equal(norm(browserTier(card)), rarityTier(card as any),
          `disagreement on ${JSON.stringify(card)}: browser=${browserTier(card)} api=${rarityTier(card as any)}`);
      }
    }
  }
});

test('gold and silver are the same rung in the browser copy', () => {
  // The flavours must not become rungs by accident — that was a real bug once.
  assert.equal(norm(browserTier({ parallel_name: 'Gold' })),
               norm(browserTier({ parallel_name: 'Purple' })));
});

test('an unnumbered insert is not base in either copy', () => {
  const kaboom = { print_run: null, parallel_name: null, card_type: 'Insert' };
  assert.notEqual(browserTier(kaboom), 'base');
  assert.notEqual(rarityTier(kaboom as any), 'base');
});
