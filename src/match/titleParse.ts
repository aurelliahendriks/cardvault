/**
 * Deterministic listing-title parser.
 *
 * This runs before any AI. On real eBay soccer-card titles it resolves the
 * large majority of listings on its own, which matters for two reasons:
 * cost (no token spend per listing) and stability (the same title always
 * yields the same parse, so valuations don't drift when a model changes).
 *
 * The AI layer only sees what this cannot confidently resolve.
 */

export interface ParsedTitle {
  raw: string;
  normalized: string;
  cardNumber: string | null;
  /** true when the title wrote "#214" rather than a bare "214" we inferred */
  cardNumberIsExplicit: boolean;
  /** e.g. { grader: 'PSA', grade: 10 } */
  grader: string | null;
  grade: number | null;
  /** print run denominator: "/99" -> 99, "1/1" -> 1 */
  printRun: number | null;
  isOneOfOne: boolean;
  /** candidate parallel words found in the title, in order */
  parallelHints: string[];
  /** section/insert set hints: 'Kaboom!', 'Night Moves', ... */
  sectionHints: string[];
  year: string | null;
  productHints: string[];
  /** true when the product is named unambiguously (e.g. "Donruss"), not inferred from "World Cup" */
  productHintStrong: boolean;
  isAuto: boolean;
  isRookie: boolean;
  /** hard rejects */
  reject: RejectReason | null;
  /** 0..1 — how much structure we recovered */
  structureScore: number;
  /** the leftover words most likely to be the player name */
  playerGuess: string;
}

export type RejectReason =
  | 'lot'
  | 'reprint'
  | 'custom'
  | 'break_slot'
  | 'sealed_product'
  | 'digital'
  | 'sticker'
  | 'empty_holder'
  | 'not_a_card';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const GRADERS: Record<string, string> = {
  psa: 'PSA', bgs: 'BGS', bvg: 'BGS', sgc: 'SGC', cgc: 'CGC',
  csg: 'CSG', hga: 'HGA', tag: 'TAG', ace: 'ACE', gma: 'GMA',
};

/** Parallel / finish vocabulary seen across Donruss RTWC and Panini WC 2026. */
const PARALLEL_WORDS = [
  // Donruss / Optic
  'holo', 'silver holo', 'silver', 'bronze', 'cubic', 'diamond', 'maze',
  'red and blue maze', 'red and gold maze', 'red and green maze', 'blue swirl',
  'green and blue maze', 'purple laser', 'pink velocity', 'blue velocity',
  'red velocity', 'purple velocity', 'gold velocity', 'velocity',
  'purple mojo', 'blue mojo', 'green mojo', 'gold mojo', 'mojo',
  'red laser', 'gold laser', 'laser', 'orange', 'purple', 'teal', 'pink',
  'green', 'blue', 'red', 'gold', 'black', 'white sparkle', 'sparkle',
  'shock', 'wave', 'hyper', 'reactive', 'prizm', 'refractor',
  'gold vinyl', 'nebula', 'choice', 'aqua', 'lime', 'bronze cubic',
  // Panini WC 2026 / Kayou style
  'gilded', 'manka', 'foil', 'stamp', 'legacy', 'glory', 'gold leaf',
  'rainbow', 'crystal', 'mirror', 'starburst', 'cracked ice',
  // Prizm FIFA (C). Multi-word forms are listed in full rather than as their parts:
  // 'pink power' is a parallel, 'power' on its own is a plausible surname.
  'pink power', 'pulsar', 'red pulsar', 'blue pulsar', 'pink pulsar', 'gold pulsar',
  'black pulsar', 'mosaic', 'orange mosaic', 'blue mosaic', 'purple mosaic',
  'pink mosaic', 'red mosaic', 'gold mosaic', 'shimmer', 'blue shimmer',
  'gold shimmer', 'green shimmer', 'black shimmer', 'snakeskin', 'soccer ball',
  'genesis', 'teal ice', 'green ice', 'white lazer', 'lazer', 'purple wave',
  'pink mojo', 'cherry blossom', 'plum blossom', 'lotus flower', 'snake year',
  'black finite', 'checker', 'red and white checker',
  // Select RTWC 26 (D)
  'ice', 'red ice', 'pink ice', 'black ice', 'flash', 'red and green flash',
  'checkerboard', 'blue checker', 'honeycomb', 'peacock', 'red pandora',
  'panini logo', 'dragon scale', 'black dragon scale', 'orange mojo',
  'neon purple pulsar', 'snakeskin pulsar',
  // Topps Chrome UCC (E). Topps calls its parallels refractors.
  'teal refractor', 'black refractor', 'red refractor', 'superfractor',
  'x-fractor', 'xfractor', 'mini-diamond refractor', 'mini diamond',
  'raywave refractor', 'raywave', 'frozenfractor',
];

/** Insert / section vocabulary. Keys map to the `section` values in `cards`. */
const SECTION_WORDS: Record<string, string> = {
  'kaboom': 'Kaboom!',
  'kaboom!': 'Kaboom!',
  'night moves': 'Night Moves',
  'zero gravity': 'Zero Gravity',
  'beautiful game': 'Beautiful Game Autographs',
  'signature series': 'Signature Series',
  'elite series': 'Elite Series',
  'kit kings': 'Kit Kings',
  'kit series': 'Kit Series',
  'pitch kings': 'Pitch Kings',
  'rookie kings': 'Rookie Kings',
  'net marvels': 'Net Marvels',
  'craftsmen': 'Craftsmen',
  'dominators': 'Dominators',
  'magicians': 'Magicians',
  'animation': 'Animation',
  'base optic': 'Base Optic',
  'optic': 'Base Optic',
  'coalition': 'Coalition',
  'glory cup': 'Glory Cup',
  'gold leaf': 'Gold Leaf',
  'golden': 'Golden',
  'pictorial': 'Pictorial',
  'superstar': 'Superstar',
  'moment': 'Moment',
  'legend': 'Legend',
  // Select's three base tiers. These are sections, not parallels: each tier has its own
  // card numbers (Terrace 1-100, Mezzanine 101-200, Field Level 201-250) and its own
  // scarcity, so "field level" narrows which card you mean, not which finish it has.
  'terrace': 'Base Terrace',
  'mezzanine': 'Base Mezzanine',
  'field level': 'Base Field Level',
};

/**
 * Product inference. Sellers write the set name in every possible order
 * ("2026 Panini FIFA World Cup", "Panini World Cup 2026", "Donruss RTWC 25/26"),
 * so match on independent signals rather than fixed phrases.
 */
const PRODUCT_RULES: Array<[RegExp, string[], 'strong' | 'weak']> = [
  // Order matters twice over: the first STRONG hit wins and stops the loop, and several of
  // these patterns overlap on purpose.
  //
  //   "select road to world cup"  matches both the Select rule and the Donruss RTWC rule.
  //                               Select is the more specific of the two, so it goes first.
  //   "topps chrome"              is the only non-Panini product here.
  //
  [/\bselect\b/i, ['D'], 'strong'],
  [/\b(topps|chrome|ucc\b|uefa)\b/i, ['E'], 'strong'],
  // Prizm needs qualifying. "Prizm" names BOTH product C and a 48-card insert section
  // inside product B, so the bare word is genuinely ambiguous and deliberately emits no
  // hint at all - see the note under the weak rules.
  [/\b(panini )?prizm (fifa|soccer|20\d{2}|2[4-7][-\/]2[4-7])\b|\bfifa prizm\b/i, ['C'], 'strong'],
  [/\b(donruss|road to (the )?world cup|road to wc|rtwc)\b/i, ['A'], 'strong'],

  // Weak: a nudge, never a filter.
  //
  // "Panini FIFA World Cup 2026" does not identify a product - both A and B are Panini
  // World Cup sets. That distinction was worth a bug once already.
  [/\b(fifa )?world cup\b/i, ['B'], 'weak'],
  [/\bwc ?2026\b/i, ['B'], 'weak'],
  // The season used to be a STRONG signal for Donruss, which was true while Donruss was
  // the only 2025-26 set in the database. Prizm, Select and Topps Chrome are all 2025-26
  // too, so as a strong rule it now actively mis-routes three products into A. It says
  // one real thing - "not the 2026 World Cup set" - and that is all it now claims.
  [/\b(2025[-\/]26|25[-\/]26)\b/, ['A', 'C', 'D', 'E'], 'weak'],
  //
  // Deliberately absent: a bare `\bprizm\b` rule. Product C is "Panini Prizm FIFA" and
  // product B has a section literally named "Prizm", so a lone "prizm" is evidence for
  // both in equal measure. Emitting a hint either way would push somebody's B Prizm
  // insert into C or vice versa; emitting none leaves the card number and player name to
  // decide, which is what they are good at.
];

// Reject patterns. Order matters: the first hit wins.
const REJECTS: Array<[RegExp, RejectReason]> = [
  [/\b(reprint|re-print|rp\b|novelty|aceo|fantasy card)\b/i, 'reprint'],
  [/\b(custom|hand ?made|art card|homemade|fan made)\b/i, 'custom'],
  [/\b(break|breaking|random team|random player|pyt\b|pick your team|spot\b|filler)\b/i, 'break_slot'],
  [/\b(sealed|factory sealed|blaster|hobby box|mega box|tin\b|case\b|pack\b|packs\b|booster|hanger|fat pack)\b/i, 'sealed_product'],
  [/\b(digital|nft|topps ?now digital|panini blockchain)\b/i, 'digital'],
  [/\b(sticker|album|adrenalyn|match attax)\b/i, 'sticker'],
  [/\b(empty (slab|holder|case)|graded case only|display case)\b/i, 'empty_holder'],
  // "lot of 5", "5 card lot", "bundle", "x10", "job lot", "set of"
  [/\b(lot of \d+|\d+\s*card lot|job ?lot|bundle of|bulk lot|set of \d+|complete set|team set|\d+\s*x\s*(cards?|lot))\b/i, 'lot'],
  [/\bx\s?(\d{2,})\b/i, 'lot'],
  [/\b(jersey|shirt|scarf|ball\b|boots|poster|magazine|figure|funko)\b/i, 'not_a_card'],
];

// ---------------------------------------------------------------------------

export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')     // strip accents: Mbappé -> Mbappe
    .replace(/[’'`]/g, '')
    .replace(/[^a-zA-Z0-9#\/\-. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseTitle(raw: string): ParsedTitle {
  const normalized = normalize(raw);
  const low = normalized.toLowerCase();

  // --- hard rejects -------------------------------------------------------
  let reject: RejectReason | null = null;
  for (const [re, why] of REJECTS) {
    if (re.test(low)) { reject = why; break; }
  }
  // "1 of 1" and "/1" are legitimate; don't let the lot regex eat them.
  if (reject === 'lot' && /\b(1\s*(of|\/)\s*1|one of one)\b/i.test(low)) reject = null;

  // --- grade --------------------------------------------------------------
  // Detect the grading company independently of the number, because plenty of
  // real titles name one without the other ("BGS Black Label", "PSA graded").
  let grader: string | null = null;
  let grade: number | null = null;

  const graderMatch = low.match(/\b(psa|bgs|bvg|sgc|cgc|csg|hga|tag|ace|gma)\b/);
  if (graderMatch) grader = GRADERS[graderMatch[1]!]!;

  const gm = low.match(
    /\b(psa|bgs|bvg|sgc|cgc|csg|hga|tag|ace|gma)\s*\.?\s*(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5|4|3|2|1)\b/,
  );
  if (gm) {
    grader = GRADERS[gm[1]!]!;
    grade = Number(gm[2]);
  } else if (/\bgem\s*(mt|mint)\s*10\b/.test(low)) {
    grader ??= 'PSA';
    grade = 10;
  }
  // BGS "Black Label" is a 10/10/10/10 — a grade, just not written as a number.
  if (grader === 'BGS' && /\bblack label\b|\bpristine\b/.test(low)) grade = 10;
  // A bare grader token with no grade and no "graded"/"slab" context is more
  // likely someone's username or noise than a real slab.
  if (grader && grade == null && !/\b(graded|slab|slabbed|gem|mint|label|pristine)\b/.test(low)) {
    grader = null;
  }

  // --- print run ----------------------------------------------------------
  let printRun: number | null = null;
  let isOneOfOne = /\b(1\s*of\s*1|one of one|1\/1)\b/.test(low);
  // "/99", "#/25", "23/50", "SP /10"
  const runMatches = [...low.matchAll(/(?:^|[\s#(])(?:(\d{1,4})\s*)?\/\s*(\d{1,4})\b/g)];
  for (const m of runMatches) {
    const denom = Number(m[2]);
    const numer = m[1] ? Number(m[1]) : null;
    if (!Number.isFinite(denom) || denom < 1 || denom > 5000) continue;
    if (numer != null && numer > denom) continue;

    // Season notation is the trap here: "Donruss Road to World Cup 25/26" is
    // not a card numbered 25 of 26. Consecutive two-digit numbers in the
    // 2020s range are a season, full stop.
    if (numer != null && numer >= 20 && numer <= 30 && denom === numer + 1) continue;
    // Same for the four-digit form, "2025/26".
    if (numer != null && numer >= 2020 && numer <= 2030 && denom === (numer % 100) + 1) continue;

    printRun = printRun == null ? denom : Math.min(printRun, denom);
  }
  if (isOneOfOne) printRun = 1;
  if (printRun === 1) isOneOfOne = true;

  // --- card number --------------------------------------------------------
  // Prefer an explicit "#214"; fall back to "no. 214" / "card 214".
  let cardNumber: string | null = null;
  let cardNumberIsExplicit = false;
  const notANumber = (c: string) => /^(19|20)\d{2}$/.test(c);

  const hashed = [...low.matchAll(/#\s*([a-z]{0,3}-?\d{1,4})\b/g)].map((m) => m[1]!);
  const worded = [...low.matchAll(/\b(?:no\.?|card|card no\.?)\s*([a-z]{0,3}-?\d{1,4})\b/g)].map((m) => m[1]!);
  const explicit = [...hashed, ...worded].filter((c) => !notANumber(c));

  if (explicit.length) {
    cardNumber = explicit[0]!.toUpperCase();
    cardNumberIsExplicit = true;
  } else {
    // Plenty of sellers write "Gilberto Mora 214 Rated Rookie" with no hash.
    // Take a bare 1-3 digit token as a weaker hint: scored the same, but the
    // matcher won't accept on it alone without corroborating evidence.
    const stripped = low
      .replace(/\d{0,4}\s*\/\s*\d{1,4}/g, ' ')                          // print runs
      .replace(/\b(psa|bgs|bvg|sgc|cgc|csg)\s*\.?\s*[\d.]+\b/g, ' ')    // grades
      .replace(/\b(19|20)\d{2}(?:[-\/]\d{2})?\b/g, ' ');                // years/seasons
    const bare = [...stripped.matchAll(/(?:^|\s)(\d{1,3})(?=\s|$)/g)].map((m) => m[1]!);
    if (bare.length === 1) cardNumber = bare[0]!;
  }

  // --- year / product -----------------------------------------------------
  const ym = low.match(/\b(20(2[4-7]))(?:[-\/](2[4-7]))?\b/);
  const year = ym ? ym[0] : null;

  const productHints: string[] = [];
  let productHintStrong = false;
  for (const [re, codes, strength] of PRODUCT_RULES) {
    if (!re.test(normalized)) continue;
    if (strength === 'strong') {
      // A strong signal overrides everything weak that came before it.
      productHints.length = 0;
      productHints.push(...codes);
      productHintStrong = true;
      break;
    }
    for (const code of codes) if (!productHints.includes(code)) productHints.push(code);
  }

  // --- sections -----------------------------------------------------------
  const sectionHints: string[] = [];
  // longest-first so "base optic" beats "optic"
  for (const word of Object.keys(SECTION_WORDS).sort((a, b) => b.length - a.length)) {
    if (low.includes(word)) {
      const sec = SECTION_WORDS[word]!;
      if (!sectionHints.includes(sec)) sectionHints.push(sec);
    }
  }

  // --- parallels ----------------------------------------------------------
  const parallelHints: string[] = [];
  for (const word of [...PARALLEL_WORDS].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?:^|\\s)${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`, 'i');
    if (re.test(low)) {
      // don't double-count "silver" inside "silver holo"
      if (parallelHints.some((p) => p.includes(word))) continue;
      parallelHints.push(word);
    }
  }

  const isAuto = /\b(auto|autograph|autographed|signed|signature|on ?card auto|sticker auto)\b/.test(low);
  const isRookie = /\b(rookie|rc\b|rated rookie|rr\b|1st|first)\b/.test(low);

  // --- player guess -------------------------------------------------------
  // Strip everything we recognised, then keep runs of capitalised words.
  let residue = normalized;
  const strip = [
    /\b(psa|bgs|bvg|sgc|cgc|csg|hga|tag|ace|gma)\s*\.?\s*[\d.]+\b/gi,
    /#\s*[a-z]{0,3}-?\d{1,4}\b/gi,
    /\d{0,4}\s*\/\s*\d{1,4}/g,
    /\b(20\d{2})([-\/]\d{2})?\b/g,
    // Set/brand words. Anything left in the residue becomes the player guess and is
    // trigram-matched against real names, so a brand word left behind is not cosmetic:
    // "salah topps 136" scored 0.375 against "Mohamed Salah" and fell below the accept
    // threshold purely because `topps` was still attached to it.
    /\b(panini|donruss|optic|topps|chrome|select|uefa|ucc|champions league|fifa|world cup|road to|rtwc|wc|prizm|soccer|football|card|cards|mint|nm|gem|graded|rookie|rc|rated|auto|autograph|signed|insert|parallel|sp|ssp|base|numbered|refractor)\b/gi,
  ];
  for (const re of strip) residue = residue.replace(re, ' ');
  for (const w of [...PARALLEL_WORDS, ...Object.keys(SECTION_WORDS)]) {
    residue = residue.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ');
  }
  residue = residue.replace(/\s+/g, ' ').trim();
  // Player names are usually the longest surviving capitalised run.
  const runs = residue.match(/(?:\b[A-Z][a-zA-Z-]{1,}\b\s*){1,4}/g) ?? [];
  const playerGuess = (runs.sort((a, b) => b.trim().length - a.trim().length)[0] ?? residue)
    .trim()
    .slice(0, 60);

  // --- structure score ----------------------------------------------------
  let score = 0;
  if (cardNumber) score += cardNumberIsExplicit ? 0.35 : 0.20;
  if (playerGuess.length >= 4) score += 0.25;
  if (sectionHints.length) score += 0.15;
  if (productHints.length || year) score += 0.15;
  if (parallelHints.length || printRun || grader) score += 0.10;

  return {
    raw, normalized, cardNumber, cardNumberIsExplicit, grader, grade, printRun, isOneOfOne,
    parallelHints, sectionHints, year, productHints, productHintStrong, isAuto, isRookie,
    reject, structureScore: Math.min(1, score), playerGuess,
  };
}

/** Print-run denominator embedded in a parallel name, e.g. "Gold (#/10)" -> 10. */
export function printRunFromParallelName(name: string): number | null {
  const m = name.match(/\/\s*(\d{1,4})/);
  if (m) return Number(m[1]);
  const m2 = name.match(/\b(\d{1,4})\s*(?:copies|made)\b/i);
  return m2 ? Number(m2[1]) : null;
}
