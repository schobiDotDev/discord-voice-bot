/**
 * Standalone logger for browser mode
 * Avoids importing the shared config module (which requires DISCORD_TOKEN)
 */

const LOG_LEVEL = parseInt(process.env.LOG_LEVEL ?? '2', 10);

function formatMessage(level: string, message: string): string {
  return `[${new Date().toISOString()}] [${level}] ${message}`;
}

export const logger = {
  error(message: string): void {
    console.error(formatMessage('ERROR', message));
  },
  warn(message: string): void {
    if (LOG_LEVEL >= 2) console.warn(formatMessage('WARN', message));
  },
  info(message: string): void {
    if (LOG_LEVEL >= 2) console.info(formatMessage('INFO', message));
  },
  debug(message: string): void {
    if (LOG_LEVEL >= 3) console.debug(formatMessage('DEBUG', message));
  },
};
