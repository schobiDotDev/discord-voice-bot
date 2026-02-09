import { config } from './config.js';
import { logger } from './utils/logger.js';
import { DmCallService } from './services/dm-call-service-v2.js';
import { DmCallApi } from './services/dm-call-api.js';
import { ensureDirectories } from './utils/audio.js';

/**
 * DM-Call Service — Standalone Entrypoint
 *
 * Runs an independent HTTP server that accepts POST /call requests
 * from OpenClaw to initiate Discord DM voice calls via CDP + BlackHole.
 *
 * Usage:
 *   npm run dm-call          # production
 *   npm run dm-call:dev      # with file watching
 */
async function main() {
  logger.info('Starting DM-Call Service...');
  logger.info(`CDP URL: ${config.dmCall.cdpUrl}`);
  logger.info(`Port: ${config.dmCall.port}`);

  await ensureDirectories();

  const callService = new DmCallService();
  const api = new DmCallApi(config.dmCall.port, callService);
  await api.start();

  logger.info(`DM-Call Service ready on port ${config.dmCall.port}`);

  const shutdown = async () => {
    logger.info('Shutting down DM-Call Service...');
    await callService.dispose();
    await api.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', async (err) => {
    logger.error(`Fatal: ${err.message}`);
    await callService.dispose();
    process.exit(1);
  });
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  logger.error(`Fatal: ${msg}`);
  process.exit(1);
});
