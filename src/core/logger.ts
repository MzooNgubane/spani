import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { PATHS, ensureDataDirs } from './paths.js';
import { loadConfig } from './config.js';

/**
 * Paths whose VALUES must never reach a log line or an AI prompt.
 * Matched as substrings against the profile dot-path or the key name.
 */
export const REDACT_KEYS = [
  'id_number', 'passport', 'account_number', 'bank', 'password', 'secret',
  'token', 'app_password', 'otp', 'pin', 'payslip', 'salary',
];

export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 4 ? `«redacted:${value.length}»` : '«redacted»';
  return '«redacted»';
}

ensureDataDirs();

const cfg = loadConfig();
const logFile = path.join(PATHS.logs, `spani-${new Date().toISOString().slice(0, 10)}.jsonl`);

export const logger = pino(
  {
    level: cfg.log.level,
    redact: {
      paths: REDACT_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]),
      censor: '«redacted»',
    },
    base: { pid: undefined, hostname: undefined },
  },
  pino.multistream([
    { stream: fs.createWriteStream(logFile, { flags: 'a' }) },
    { stream: pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }) },
  ]),
);

export type Logger = typeof logger;
