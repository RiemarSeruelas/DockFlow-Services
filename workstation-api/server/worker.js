import { createCompanyWorker } from './worker-core.js';
import { log, safeError } from './logger.js';

const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  log.info('worker.stop_requested', { signal });
  controller.abort();
});
try {
  await createCompanyWorker({ key: process.env.COMPANY_API_KEY,
    base: process.env.UBUNTU_BRIDGE_URL, signal: controller.signal }).run();
} catch (error) {
  log.error('worker.start_failed', { failure: safeError(error) });
  process.exitCode = 1;
}
