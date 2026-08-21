-- CardVault :: reference data
-- Fee rates, shipping costs and community metadata are STARTING POINTS.
-- They live in the DB precisely so you can tune them without a redeploy.
-- See docs/FEES.md before trusting the "where to sell" output for a big card.

INSERT INTO products (code, name, manufacturer, season, release_date) VALUES
  ('A', 'Donruss Road to World Cup 25/26', 'Panini', '2025-26', '2025-11-01'),
  ('B', 'Panini FIFA World Cup 2026',      'Panini', '2026',    '2026-04-01')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Marketplaces
-- fee_pct / fee_fixed verified July 2026 for eBay trading cards (13.25% + $0.40
-- US, non-store). Other sites are best-effort; confirm before relying on them.
-- ship_from_au_cost = tracked small parcel from Australia, in AUD.
-- ---------------------------------------------------------------------------
INSERT INTO marketplaces
 (code, name, region, currency, ebay_marketplace_id, fee_pct, fee_fixed, fee_fixed_ccy,
  intl_fee_pct, payment_fee_pct, ad_rate_typical, ship_from_au_cost, ship_days_est,
  customs_risk, requires_local_entity, price_realization, min_value_aud, max_value_aud,
  audience_note)
VALUES
 ('EBAY_AU','eBay Australia','AU','AUD','EBAY_AU',0.1325,0.40,'AUD',
  0.0000,0.0000,0.0200, 9.00, 4, 0.00, FALSE,
  1.000,3,NULL,
  'Home market. No FX loss, no customs, cheapest postage, but the thinnest bidder pool for soccer.'),
 ('EBAY_US','eBay United States','US','USD','EBAY_US',0.1325,0.40,'USD',
  0.0165,0.0000,0.0200, 18.00, 12, 0.35, FALSE,
  1.000,15,NULL,
  'Deepest sports-card money on earth. Best for Kabooms, autos, low-numbered parallels. US card tariffs add buyer friction.'),
 ('EBAY_UK','eBay United Kingdom','UK','GBP','EBAY_UK',0.1300,0.30,'GBP',
  0.0165,0.0000,0.0200, 16.00, 10, 0.25, FALSE,
  1.000,15,NULL,
  'Strong football (not "soccer") culture. England/Wales players and Premier League names over-index here.'),
 ('EBAY_DE','eBay Germany','DE','EUR','EBAY_DE',0.1100,0.35,'EUR',
  0.0165,0.0000,0.0200, 16.00, 10, 0.30, FALSE,
  1.000,15,NULL,
  'Lower fees. Big Bundesliga/Germany collector base; Panini is the native brand in Europe.'),
 ('EBAY_ES','eBay Spain','ES','EUR','EBAY_ES',0.1100,0.35,'EUR',
  0.0165,0.0000,0.0200, 16.00, 11, 0.30, FALSE,
  1.000,15,NULL,
  'Yamal, Spain squad, La Liga names. Smaller pool but very targeted demand.'),
 ('EBAY_JP','eBay Japan (cross-border)','JP','USD','EBAY_JP',0.1325,0.40,'USD',
  0.0165,0.0000,0.0200, 15.00, 8, 0.10, FALSE,
  1.000,20,NULL,
  'Thin for soccer, but Japanese buyers pay up for graded/pristine and for Japan squad players.'),
 ('MERCARI_JP','Mercari Japan','JP','JPY',NULL,0.1000,0.00,'JPY',
  0.0000,0.0000,0.0000, 15.00, 9, 0.10, TRUE,
  0.950,10,4000,
  'Cheap 10% flat fee and real Japanese demand, but effectively needs a JP address/bank — use a proxy service (Buyee/Tenso) or skip.'),
 ('YAHOO_JP','Yahoo! Auctions Japan','JP','JPY',NULL,0.1000,0.00,'JPY',
  0.0000,0.0000,0.0000, 15.00, 9, 0.10, TRUE,
  0.980,10,8000,
  'Where Japanese collectors actually bid. Same local-entity problem as Mercari.'),
 ('ML_MX','MercadoLibre Mexico','MX','MXN',NULL,0.1600,10.00,'MXN',
  0.0000,0.0400,0.0000, 22.00, 18, 0.40, TRUE,
  1.000,10,3000,
  'Host-nation demand engine for 2026. Gilberto Mora and the Mexico squad command a premium here that eBay does not see. High fees, hard cross-border logistics.'),
 ('ML_AR','MercadoLibre Argentina','AR','ARS',NULL,0.1600,0.00,'ARS',
  0.0000,0.0400,0.0000, 24.00, 22, 0.60, TRUE,
  1.000,10,2000,
  'Messi country. Enormous passion, brutal FX/capital controls and import restrictions — usually better to reach these buyers via eBay US.'),
 ('SHOPEE_SG','Shopee Singapore','SG','SGD',NULL,0.0800,0.00,'SGD',
  0.0000,0.0200,0.0000, 12.00, 8, 0.10, TRUE,
  0.850,5,600,
  'Cheap fees, growing SEA card scene, but low ceiling — commons and mid-tier only.'),
 ('WHATNOT_AU','Whatnot (live auction)','AU','AUD',NULL,0.0800,0.00,'AUD',
  0.0000,0.0290,0.0000, 9.00, 4, 0.00, FALSE,
  0.870,10,3000,
  'Live-stream auctions. Excellent for clearing volume/lots fast at ~80-90% of eBay price. 8% + payment fee.'),
 ('PWCC','Fanatics Collect / PWCC weekly','US','USD',NULL,0.2000,0.00,'USD',
  0.0000,0.0000,0.0000, 25.00, 21, 0.35, FALSE,
  1.150,1500,NULL,
  'Consignment auction house. Only worth it above ~A$1500: their bidder pool sets records on Kabooms and 1/1s. ~20% all-in seller cost.'),
 ('GOLDIN','Goldin Auctions','US','USD',NULL,0.2000,0.00,'USD',
  0.0000,0.0000,0.0000, 25.00, 28, 0.35, FALSE,
  1.200,5000,NULL,
  'Top-end only, A$5k+. Buyer premium does the work; seller cost negotiable at high value.'),
 ('FACEBOOK_AU','Facebook groups (AU)','AU','AUD',NULL,0.0000,0.00,'AUD',
  0.0000,0.0000,0.0000, 5.00, 3, 0.00, FALSE,
  0.870,15,400,
  'Zero fees, PayID/bank transfer, fast for A$20-300. Price realization ~85-90% of eBay. Scam risk both ways.'),
 ('LOCAL_LCS','Local card shop / show','AU','AUD',NULL,0.0000,0.00,'AUD',
  0.0000,0.0000,0.0000, 0.00, 0, 0.00, FALSE,
  0.500,0,NULL,
  'Instant cash, but shops buy at 40-60% of market. Only for bulk clearing.')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Sources
-- ---------------------------------------------------------------------------
INSERT INTO sources (code, name, kind, gives_sold, trust_weight, enabled, config) VALUES
 ('ebay_browse',   'eBay Browse API (active listings)', 'api',    FALSE, 0.55, TRUE,
   '{"note":"Asking prices. Used for supply/sell-through, and as a weak price signal only."}'),
 ('ebay_insights', 'eBay Marketplace Insights API (90d sold)', 'api', TRUE, 1.00, FALSE,
   '{"note":"Limited-release: requires an application to eBay. Highest-quality sold data when granted."}'),
 ('brightdata_ebay_sold', 'Bright Data - eBay sold listings', 'scrape', TRUE, 0.90, FALSE,
   '{"note":"Costs per request. Best fallback for sold comps when Insights is not approved."}'),
 ('brightdata_serp', 'Bright Data - SERP discovery', 'scrape', FALSE, 0.40, FALSE, '{}'),
 ('scrape_sportscardspro', 'SportsCardsPro sold history', 'scrape', TRUE, 0.85, FALSE,
   '{"note":"Aggregated sold data. Respect robots.txt and their terms; low request rate."}'),
 ('scrape_130point', '130point sold search', 'scrape', TRUE, 0.85, FALSE,
   '{"note":"Aggregates eBay + Goldin + PWCC sold. Manual/low-volume use."}'),
 ('csv_import',    'Manual CSV / clipboard comps', 'manual', TRUE, 1.00, TRUE, '{}'),
 ('manual_entry',  'Manual price override', 'manual', TRUE, 1.00, TRUE, '{}')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Communities / channels
-- price_realization is relative to eBay market price; speed_score is 0..1.
-- ---------------------------------------------------------------------------
INSERT INTO communities
 (name, kind, region, url, fee_pct, audience_size, focus_sections, focus_teams,
  min_value_aud, max_value_aud, likes_lots, likes_graded, speed_score, price_realization, notes)
VALUES
 ('r/soccercards','reddit','GLOBAL','https://reddit.com/r/soccercards',0.0000,120000,
  '{}','{}',30,3000,FALSE,TRUE,0.60,0.92,
  'The default global soccer-card room. Sale threads + a lot of price discovery. Build comment history before selling.'),
 ('r/footballcards','reddit','GLOBAL','https://reddit.com/r/footballcards',0.0000,40000,
  '{}','{}',30,2000,FALSE,TRUE,0.50,0.90,
  'Europe-leaning overlap with r/soccercards.'),
 ('Soccer Cards HQ Discord','discord','GLOBAL',NULL,0.0000,25000,
  '{Kaboom!,"Signature Series","Beautiful Game Autographs"}','{}',100,20000,FALSE,TRUE,0.75,0.95,
  'Where the high-end soccer money actually talks. Best channel for Kabooms and autos without paying auction-house rates.'),
 ('Australian Sports Cards (FB)','facebook_group','AU',NULL,0.0000,45000,
  '{}','{}',20,1500,TRUE,FALSE,0.70,0.88,
  'Biggest AU group. Fast, fee-free, PayID. Great for A$20-300 singles and lots.'),
 ('Aussie Soccer / Football Cards (FB)','facebook_group','AU',NULL,0.0000,9000,
  '{}','{Australia}','15',800,TRUE,FALSE,0.60,0.85,
  'Smaller but exactly the right audience for Socceroos and A-League crossovers.'),
 ('Tarjetas y Estampas Mexico (FB)','facebook_group','MX',NULL,0.0000,30000,
  '{Base,"Rookie Kings"}','{Mexico}',15,1200,TRUE,FALSE,0.65,1.05,
  'Host-nation heat. Mexico squad and Gilberto Mora rookies clear ABOVE eBay AU here. Payment via MercadoPago/transfer is the friction.'),
 ('Argentina Cartas de Futbol (FB)','facebook_group','AR',NULL,0.0000,35000,
  '{}','{Argentina}',20,2000,FALSE,FALSE,0.60,1.00,
  'Messi/Argentina demand. FX and shipping make settlement painful; treat as a lead source, close on eBay US.'),
 ('Blowout Forums - Soccer','forum','US','https://blowoutforums.com',0.0000,15000,
  '{Kaboom!,"Signature Series"}','{}',80,15000,FALSE,TRUE,0.55,0.95,
  'Old-school US forum. Serious buyers, low fees, slow but honest.'),
 ('Whatnot soccer breaks/auctions','whatnot','GLOBAL','https://whatnot.com',0.0800,200000,
  '{}','{}',10,1500,TRUE,TRUE,0.90,0.85,
  'Fastest liquidity for volume. Ideal for the "sell in player lots" problem with A$2-5 base cards.'),
 ('eBay AU store','marketplace','AU',NULL,0.1325,0,
  '{}','{}',5,NULL,TRUE,TRUE,0.65,1.00,
  'Baseline. Everything is measured against this.'),
 ('eBay US','marketplace','US',NULL,0.1490,0,
  '{}','{}',15,NULL,TRUE,TRUE,0.70,1.00,
  'Baseline for anything above ~A$100.'),
 ('Card shows (AU capital cities)','show','AU',NULL,0.0000,0,
  '{}','{}',50,5000,TRUE,TRUE,0.40,0.90,
  'Good for moving a box of mid-tier in one day. Dealers lowball; collector table sales are fine.'),
 ('Mana Market / Slabbys community','lcs','AU',NULL,0.0000,0,
  '{}','{}',50,NULL,FALSE,TRUE,0.45,0.85,
  'Grading middlemen who also broker. Useful pairing: grade + sell through the same relationship.')
ON CONFLICT DO NOTHING;

-- Seed FX so a cold start can still price things. The worker refreshes daily.
INSERT INTO fx_rates (as_of, base, quote, rate, source) VALUES
 (CURRENT_DATE,'USD','AUD',1.4000,'seed'),
 (CURRENT_DATE,'AUD','USD',0.7143,'seed'),
 (CURRENT_DATE,'GBP','AUD',1.9200,'seed'),
 (CURRENT_DATE,'EUR','AUD',1.6300,'seed'),
 (CURRENT_DATE,'JPY','AUD',0.0094,'seed'),
 (CURRENT_DATE,'MXN','AUD',0.0760,'seed'),
 (CURRENT_DATE,'ARS','AUD',0.0011,'seed'),
 (CURRENT_DATE,'SGD','AUD',1.0900,'seed'),
 (CURRENT_DATE,'AUD','AUD',1.0000,'seed')
ON CONFLICT DO NOTHING;
