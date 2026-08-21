/**
 * Search launchers: build the URL, let the human click it.
 *
 * This exists because the two places you most want to look are the two you cannot
 * legitimately automate.
 *
 * **Facebook Marketplace** has no public API for listings, requires a logged-in session,
 * and publishes no sold prices. Scraping it means driving a browser with your own
 * credentials against Meta's terms — risking the account you sell from — to obtain asking
 * prices, which are not comps. The honest tool is a link that lands you on the right
 * search, centred where you actually live.
 *
 * **Google** organic results have no free API either, and Trends has no official one at
 * all. A Trends *comparison URL* answers "is this hotter in Europe or China" perfectly
 * well, and it takes one click.
 *
 * So nothing here fetches anything. Every function returns a URL. That is a deliberate
 * ceiling, not an unfinished feature: the alternative is a scraper that breaks silently,
 * violates terms, and fills the database with asking prices dressed up as sales.
 *
 * Real regional *prices* come from somewhere else entirely — per-marketplace comps, which
 * the ingest pipeline already collects. See `regional_demand`.
 */

export interface CardQuery {
  player: string;
  section?: string | null;
  cardNumber?: string | null;
  parallelName?: string | null;
  printRun?: number | null;
  grader?: string | null;
  grade?: string | number | null;
  productCode?: string | null;
  team?: string | null;
}

/** Where the user is, for the local searches. Defaults to Melbourne. */
export interface Locale {
  city: string;
  /** Facebook Marketplace uses numeric place ids in its URLs; Melbourne's is stable. */
  fbPlaceId: string;
  gumtreeSlug: string;
  radiusKm: number;
  countryCode: string;
}

export const MELBOURNE: Locale = {
  city: 'Melbourne',
  fbPlaceId: '111749395521304',
  gumtreeSlug: 'l3008842',           // Melbourne region
  radiusKm: 60,
  countryCode: 'AU',
};

export interface SearchLink {
  channel: string;
  label: string;
  url: string;
  /** What you will actually get, including when the answer is "asking prices only". */
  note: string;
  group: 'local' | 'sold' | 'international' | 'interest';
}

const PRODUCT_NAME: Record<string, string> = {
  A: 'Donruss Road to World Cup',
  B: 'Panini FIFA World Cup 2026',
};

/**
 * The search string. Deliberately short.
 *
 * Long queries return nothing on marketplace search engines, which do token matching
 * rather than anything clever — "2025-26 Donruss Road to World Cup Gilberto Mora 214
 * Rated Rookie Teal /199 PSA 10" matches no listing anybody ever wrote. Player plus the
 * one or two most distinguishing tokens is what actually finds cards.
 */
export function queryFor(c: CardQuery, opts: { verbose?: boolean } = {}): string {
  const bits: string[] = [c.player];
  if (c.parallelName) bits.push(c.parallelName.replace(/\s*\(.*?\)\s*/g, '').trim());
  if (c.printRun) bits.push(`/${c.printRun}`);
  if (c.grader) bits.push(`${c.grader} ${c.grade ?? ''}`.trim());
  if (opts.verbose) {
    if (c.section && !/^base$/i.test(c.section)) bits.push(c.section);
    if (c.cardNumber) bits.push(`#${c.cardNumber}`);
    if (c.productCode && PRODUCT_NAME[c.productCode]) bits.push(PRODUCT_NAME[c.productCode]!);
  } else if (c.section && !/^base( optic)?$/i.test(c.section)) {
    bits.push(c.section);
  }
  return bits.join(' ').replace(/\s+/g, ' ').trim();
}

const enc = (s: string) => encodeURIComponent(s);

/**
 * eBay sold-and-completed search, per site.
 *
 * `LH_Sold=1&LH_Complete=1` is the whole point — without both, you are looking at what
 * people are *asking*, which is the single most common way collectors talk themselves
 * into a valuation.
 */
function ebaySold(domain: string, q: string): string {
  return `https://www.${domain}/sch/i.html?_nkw=${enc(q)}&LH_Sold=1&LH_Complete=1&_sop=13`;
}

export function searchLinks(c: CardQuery, locale: Locale = MELBOURNE): SearchLink[] {
  const q = queryFor(c);
  const qLong = queryFor(c, { verbose: true });
  const links: SearchLink[] = [];

  // --- local, where a mid-value card actually moves without postage ---------
  links.push({
    channel: 'facebook_marketplace',
    label: `Facebook Marketplace — ${locale.city} ${locale.radiusKm}km`,
    url: `https://www.facebook.com/marketplace/${locale.fbPlaceId}/search?query=${enc(q)}`
       + `&radius_km=${locale.radiusKm}&sortBy=creation_time_descend`,
    note: 'Asking prices only, and it needs you logged in. Good for finding what is '
        + 'nearby right now; useless as a price source.',
    group: 'local',
  });
  links.push({
    channel: 'facebook_groups',
    label: 'Facebook — buy/swap/sell posts',
    url: `https://www.facebook.com/search/posts?q=${enc(q + ' card')}`,
    note: 'Where the Australian trading actually happens. No sold history, so record what '
        + 'you pay or achieve as a manual comp.',
    group: 'local',
  });
  links.push({
    channel: 'gumtree',
    label: `Gumtree — ${locale.city}`,
    url: `https://www.gumtree.com.au/s-${locale.gumtreeSlug}/${enc(q.replace(/\s+/g, '-').toLowerCase())}/k0`,
    note: 'Asking prices, and slow, lowball-heavy and free. Worth it for bulk lots that '
        + 'are not worth posting.',
    group: 'local',
  });

  // --- sold prices, which is what a valuation may be built from -------------
  links.push({
    channel: 'ebay_au_sold',
    label: 'eBay AU — sold and completed',
    url: ebaySold('ebay.com.au', q),
    note: 'Real sold prices in AUD, no conversion guesswork. Your home market and the '
        + 'default comparison.',
    group: 'sold',
  });
  links.push({
    channel: 'ebay_us_sold',
    label: 'eBay US — sold and completed',
    url: ebaySold('ebay.com', q),
    note: 'Deepest market for World Cup cards. Remember the 1.65% international surcharge '
        + 'and A$16-25 postage before comparing to an AU price.',
    group: 'sold',
  });
  links.push({
    channel: 'ebay_sold_exact',
    label: 'eBay US — narrow search (full description)',
    url: ebaySold('ebay.com', qLong),
    note: 'The long query. Try it when the short one returns a mess; expect fewer results.',
    group: 'sold',
  });

  // --- international, for the "is it hotter over there" question ------------
  for (const [domain, label, note] of [
    ['ebay.co.uk', 'eBay UK', 'Strong for European squads and Premier League names.'],
    ['ebay.de', 'eBay DE', 'The main European market. Germany squad cards clear best here.'],
    ['ebay.es', 'eBay ES', 'Spain squad cards, and Yamal specifically, do better here than globally.'],
    ['ebay.it', 'eBay IT', 'Italy squad and Serie A names.'],
  ] as const) {
    links.push({
      channel: `ebay_${domain.split('.').pop()}_sold`,
      label: `${label} — sold`,
      url: ebaySold(domain, q),
      note,
      group: 'international',
    });
  }
  links.push({
    channel: 'yahoo_auctions_jp',
    label: 'Yahoo! Auctions Japan',
    url: `https://auctions.yahoo.co.jp/search/search?p=${enc(q)}&va=${enc(q)}`,
    note: 'Japan pays up for Japanese squad cards and for graded slabs. Needs a proxy '
        + 'service to actually buy or sell.',
    group: 'international',
  });
  links.push({
    channel: 'mercadolibre_mx',
    label: 'MercadoLibre Mexico',
    url: `https://listado.mercadolibre.com.mx/${enc(q.replace(/\s+/g, '-').toLowerCase())}`,
    note: 'Mexico squad cards regularly clear above global price here — host nation.',
    group: 'international',
  });
  links.push({
    channel: 'xianyu',
    label: 'Xianyu (China, second-hand)',
    url: `https://s.2.taobao.com/list/?q=${enc(q)}`,
    note: 'Where Chinese collectors actually trade, and the market Kayou sells into. No '
        + 'API, no sold history, and buying or selling needs a domestic account or an '
        + 'agent — treat this as reconnaissance.',
    group: 'international',
  });

  // --- interest, not price -------------------------------------------------
  links.push({
    channel: 'google',
    label: 'Google — everything',
    url: `https://www.google.com/search?q=${enc(qLong + ' card')}`,
    note: 'For finding shops, breakers and forum threads that no marketplace search '
        + 'surfaces.',
    group: 'interest',
  });
  links.push({
    channel: 'google_trends_regions',
    label: 'Google Trends — AU vs GB vs DE vs CN',
    url: 'https://trends.google.com/trends/explore?date=today%2012-m'
       + `&q=${enc(c.player)},${enc(c.player)},${enc(c.player)},${enc(c.player)}`
       + '&geo=AU,GB,DE,CN&hl=en-AU',
    note: 'Search interest, not demand for cards — the two diverge, and Trends is '
        + 'normalised per region so the lines are shapes, not volumes. Useful for spotting '
        + 'a spike; not evidence of a price.',
    group: 'interest',
  });
  links.push({
    channel: 'google_trends_rising',
    label: 'Google Trends — is this rising?',
    url: `https://trends.google.com/trends/explore?date=today%203-m&q=${enc(c.player)}&hl=en-AU`,
    note: 'Three-month shape for one player. A tournament spike decaying is exactly what '
        + 'the timing model predicts, so this is a cheap sanity check on it.',
    group: 'interest',
  });

  return links;
}

/** Grouped, for a UI that should not present fifteen links as one list. */
export function groupedSearchLinks(c: CardQuery, locale: Locale = MELBOURNE) {
  const all = searchLinks(c, locale);
  const groups: Array<{ group: SearchLink['group']; title: string; blurb: string; links: SearchLink[] }> = [
    { group: 'sold', title: 'What it actually sold for',
      blurb: 'Sold and completed only. Asking prices are how collectors talk themselves into a number.',
      links: [] },
    { group: 'local', title: `Near ${locale.city}`,
      blurb: 'No postage, no fees, no sold history. Record what you achieve or the data is lost.',
      links: [] },
    { group: 'international', title: 'Other markets',
      blurb: 'Where the same card might be worth more — before fees, postage and duty.',
      links: [] },
    { group: 'interest', title: 'Interest, not price',
      blurb: 'Attention is a leading indicator at best, and Trends is normalised per region.',
      links: [] },
  ];
  for (const l of all) groups.find((g) => g.group === l.group)?.links.push(l);
  return groups.filter((g) => g.links.length);
}
