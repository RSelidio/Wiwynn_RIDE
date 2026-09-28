/**
 * Structured logging. JSON in production so the Windows server's log shipper
 * can parse it; human-readable in development.
 */

import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.log.level,
  ...(config.log.pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
  // Never let a token, password or cookie reach the log file.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
    ],
    censor: '[redacted]',
  },
  base: { app: 'shuttle-backend' },
});

export type Logger = typeof logger;
