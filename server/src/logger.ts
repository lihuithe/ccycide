import { pino, type Logger } from 'pino';

export type Log = Logger;

/** 创建 pino 实例。不记录票据、签名等敏感字段（redact 兜底）。 */
export function createLogger(level = 'info', name = 'rterm'): Log {
  return pino({
    level,
    name,
    redact: {
      paths: ['ticket', '*.ticket', 'sig', '*.sig', 'signature', '*.signature', 'authorization', 'req.headers.authorization'],
      censor: '[已隐藏]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const silentLogger = (): Log => pino({ level: 'silent' });
