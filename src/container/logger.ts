export type LogLevel = "debug" | "info" | "warn" | "error" | "silent"

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
}

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * The default `ctx.logger`. Deliberately minimal — projects that want more can
 * define `services/logger.ts` or `di/logger.ts` and it takes over the key.
 */
export function createLogger(level: LogLevel = "info"): Logger {
  const enabled = (l: LogLevel) => LEVEL_ORDER[l] >= LEVEL_ORDER[level]
  const stamp = () => new Date().toISOString()
  return {
    debug: (...a) => enabled("debug") && console.debug(`[${stamp()}] DEBUG`, ...a),
    info: (...a) => enabled("info") && console.info(`[${stamp()}] INFO `, ...a),
    warn: (...a) => enabled("warn") && console.warn(`[${stamp()}] WARN `, ...a),
    error: (...a) => enabled("error") && console.error(`[${stamp()}] ERROR`, ...a),
  }
}
