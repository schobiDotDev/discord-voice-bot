import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

const mode = (process.env.MODE ?? 'bot').toLowerCase();

if (mode === 'browser') {
  // Browser mode — Puppeteer-based DM voice calls
  // Imported dynamically to avoid loading bot-mode config (which requires DISCORD_TOKEN)
  const { startBrowserMode } = await import('./modes/browser/entry.js');
  startBrowserMode().catch((error) => {
    console.error(`[${new Date().toISOString()}] [ERROR] Failed to start browser mode: ${error}`);
    process.exit(1);
  });
} else {
  // Bot mode — default Discord.js bot (existing behavior)
  const { logger } = await import('./utils/logger.js');

  // Global error handlers to prevent silent crashes
  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception: ${error.stack || error.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${reason}`);
  });

  const { Bot } = await import('./bot.js');
  const bot = new Bot();

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  bot.start().catch((error) => {
    logger.error(`Failed to start bot: ${error}`);
    process.exit(1);
  });
}
