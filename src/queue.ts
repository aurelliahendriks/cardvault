import { Queue, Worker, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { cfg } from './config.js';
import { log } from './logger.js';

export const connection = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: null });

export type JobName = 'ingest' | 'revalue' | 'recommend' | 'fx' | 'alerts' | 'match' | 'images' | 'portraits';

export const queue = new Queue('cardvault', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: 200,
    removeOnFail: 100,
  },
});

export async function enqueue(name: JobName, data: unknown = {}, opts: JobsOptions = {}) {
  const job = await queue.add(name, data, opts);
  log.info({ job: name, id: job.id }, 'enqueued');
  return job.id;
}

export function makeWorker(handler: (name: JobName, data: any) => Promise<unknown>) {
  const w = new Worker(
    'cardvault',
    async (job) => handler(job.name as JobName, job.data),
    { connection, concurrency: 1, lockDuration: 30 * 60_000 },
  );
  w.on('completed', (job) => log.info({ job: job.name, id: job.id }, 'job done'));
  w.on('failed', (job, err) => log.error({ job: job?.name, id: job?.id, err: err.message }, 'job failed'));
  return w;
}
