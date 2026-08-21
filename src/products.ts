/**
 * Short product names, in one place.
 *
 * This existed as a two-branch ternary copy-pasted into five files:
 *
 *     product_code === 'A' ? 'Donruss RTWC' : 'Panini WC26'
 *
 * which was fine while there were exactly two products and silently wrong the moment there
 * were five. Adding Prizm, Select and Topps Chrome made every one of those sites label the new
 * cards `Panini WC26` or `Custom` — a label that appears in the gallery, in search results, in
 * the bulk-add review table and in the eBay query string, so a wrong one is not cosmetic: it
 * sends you searching for the wrong card.
 *
 * Short, not the full product name, because these are read at a glance in a table cell. The
 * full names live in the `products` table and are shown on the card detail page.
 */

/** Kept deliberately in sync with `db/migrations/014_products_cde.sql`. */
export const PRODUCT_SHORT: Record<string, string> = {
  A: 'Donruss RTWC',
  B: 'Panini WC26',
  C: 'Prizm FIFA 25/26',
  D: 'Select RTWC 26',
  E: 'Topps Chrome UCC',
  X: 'Custom',
};

export function productShort(code: string | null | undefined): string {
  return PRODUCT_SHORT[String(code ?? '').toUpperCase()] ?? 'Custom';
}

/**
 * The same mapping as a SQL `CASE`, for the several queries that build a label in the database
 * rather than in JS. Generated from the map above so the two cannot drift — which is the entire
 * failure this module exists to prevent.
 */
export function productShortSql(column = 'c.product_code'): string {
  const arms = Object.entries(PRODUCT_SHORT)
    .filter(([code]) => code !== 'X')
    .map(([code, name]) => `WHEN '${code}' THEN '${name.replace(/'/g, "''")}'`)
    .join(' ');
  return `CASE ${column} ${arms} ELSE 'Custom' END`;
}
