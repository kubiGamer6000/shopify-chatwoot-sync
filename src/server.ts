import { env, assertSecuritySecrets } from './config/env.js';
import app from './app.js';
import { logger } from './utils/logger.js';
import { startPeriodicSync } from './services/sync.js';
import { startPendingSweeper } from './services/pendingSweeper.js';

assertSecuritySecrets();
if (env.legacyDashboardTokenEnabled && env.legacyDashboardTokenUntil == null) {
  logger.warn('LEGACY_DASHBOARD_TOKEN_ENABLED is on but LEGACY_DASHBOARD_TOKEN_UNTIL is not set: the legacy token stays disabled');
}

const server = app.listen(env.port, () => {
  logger.info(`Server running on port ${env.port}`);
  startPeriodicSync(env.syncIntervalHours);
  void startPendingSweeper();
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  server.close(() => process.exit(0));
});
