type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function format(level: LogLevel, message: string, data?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] ${level.toUpperCase()} ${message}`;
  return data ? `${base} ${JSON.stringify(data)}` : base;
}

export const logger = {
  info(message: string, data?: Record<string, unknown>) {
    console.log(format('info', message, data));
  },
  warn(message: string, data?: Record<string, unknown>) {
    console.warn(format('warn', message, data));
  },
  error(message: string, data?: Record<string, unknown>) {
    console.error(format('error', message, data));
  },
  debug(message: string, data?: Record<string, unknown>) {
    if (process.env.DEBUG) {
      console.debug(format('debug', message, data));
    }
  },
};
