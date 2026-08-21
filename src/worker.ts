import { cfg } from './config.js';
import { q } from './db.js';
import { runIngest } from './ingest/run.js';
import { log } from './logger.js';
import { enqueue, makeWorker, queue } from './queue.js';
import { recommendPortfolio } from './recommend/engine.js';
import { revalueAll } from './valuation/engine.js';
import { refreshFx } from './valuation/fx.js';
import { runAlerts } from './alerts.js';
import { refreshImages } from './media/images.js';
import { backfillPortraits } from './media/players.js';

makeWorker(async (name, data) => {
  switch (name) {
    case 'fx':
      return { pairs: await refreshFx() };

    case 'ingest':
      return runIngest({
        mode: data?.mode ?? 'hot',
        limit: data?.limit,
        cardIds: data?.cardIds,
        allowLlm: data?.allowLlm,
      });

    case 'revalue':
      return { valuations: await revalueAll({ onlyHeld: !!data?.onlyHeld }) };

    case 'recommend': {
      const recs = await recommendPortfolio({ limit: data?.limit, useAi: data?.useAi !== false });
      return { recommendations: recs.length };
    }

    case 'images':
      return refreshImages({ limit: data?.limit });

    case 'portraits':
      return backfillPortraits({ limit: data?.limit ?? cfg.PORTRAITS_BATCH, retryErrors: !!data?.retryErrors });

    case 'alerts':
      return runAlerts();

    default:
      log.warn({ name }, 'unknown job');
      return null;
  }
});

// --- schedules -------------------------------------------------------------
// Repeatable jobs are upserted by key so restarting the worker doesn't stack
// duplicates.
const SCHEDULES: Array<[string, string, any]> = [
  ['fx', cfg.CRON_FX, {}],
  ['ingest-hot', cfg.CRON_INGEST_HOT, { job: 'ingest', mode: 'hot' }],
  ['ingest-full', cfg.CRON_INGEST_FULL, { job: 'ingest', mode: 'full' }],
  ['revalue', cfg.CRON_REVALUE, { job: 'revalue' }],
  // Harvest card photos right after revaluation, from the listings that pass
  // just collected. Cheap, and it is what makes the gallery fill in over time.
  ['images', cfg.CRON_IMAGES, { job: 'images' }],
  // Portraits come from a free service, so this trickles rather than floods.
  ['portraits', cfg.CRON_PORTRAITS, { job: 'portraits', limit: cfg.PORTRAITS_BATCH }],
  // Alerts run far more often than anything else because their whole value is being
  // timely, and they are cheap: pure SQL over data already collected.
  //
  // This used to be registered by a second, hardcoded upsertJobScheduler call after the
  // loop. Two registrations under one key meant whichever ran last silently won, so
  // CRON_ALERTS would have looked like it did nothing. It also never logged, which is why
  // the startup output listed seven jobs while eight were running - and made the feature
  // look unscheduled when it was fine.
  ['alerts', cfg.CRON_ALERTS, { job: 'alerts' }],
  ['recommend', cfg.CRON_RECOMMEND, { job: 'recommend' }],
];

for (const [key, pattern, data] of SCHEDULES) {
  const jobName = (data.job ?? key) as any;
  await queue.upsertJobScheduler(key, { pattern }, { name: jobName, data });
  log.info({ key, pattern, jobName }, 'scheduled');
}

log.info('CardVault worker running');

// On a cold start with an empty DB, get FX in place immediately so the first
// ingest can convert prices instead of silently treating USD as AUD.
const fxCount = await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM fx_rates WHERE as_of >= CURRENT_DATE - 3`)
  .catch(() => [{ n: 0 }]);
if ((fxCount[0]?.n ?? 0) === 0) await enqueue('fx');

process.on('SIGTERM', async () => { log.info('shutting down'); process.exit(0); });
