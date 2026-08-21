import pino from 'pino';
import { cfg } from './config.js';

export const log = pino({
  level: cfg.LOG_LEVEL,
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});
