// Minimal structured logger. Emits single-line JSON to stderr so it survives in
// Termux logs and can be grepped/piped. Level gated by PRPG_LOG_LEVEL env.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const env = (process.env.PRPG_LOG_LEVEL ?? 'info').toLowerCase();
  return LEVELS[(env as LogLevel)] ?? LEVELS.info;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(level: LogLevel, bindings: Record<string, unknown>, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold()) return;
  const record = {
    t: new Date().toISOString(),
    level,
    msg,
    ...bindings,
    ...fields,
  };
  const line = JSON.stringify(record, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v));
  process.stderr.write(line + '\n');
}

export function makeLogger(bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, f) => emit('debug', bindings, m, f),
    info: (m, f) => emit('info', bindings, m, f),
    warn: (m, f) => emit('warn', bindings, m, f),
    error: (m, f) => emit('error', bindings, m, f),
    child: (extra) => makeLogger({ ...bindings, ...extra }),
  };
}

export const logger: Logger = makeLogger();
