import { body, listen, send } from './http.js';
import { addLogContext, databaseContext, log, runtimeIdentity, safeError, SERVICE_VERSION } from './logger.js';
import {
  checkDb, getDataStoreState, initializeDataStore, readDb,
  reconnectPostgres, recordPowerToolLog, writeRemoteDb,
} from './power-tool/dataStore.js';

log.info('service.started', { ...databaseContext(), automaticMigration: false });
await initializeDataStore();
async function ready() {
  if (getDataStoreState().provider !== 'postgresql') await reconnectPostgres();
  return checkDb();
}

listen(process.env.PORT || 8082, async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/api/power-tool/health' && request.method === 'GET') {
    try {
      const database = await ready();
      return send(response, 200, { ok: true, serviceVersion: SERVICE_VERSION, diagnostics: runtimeIdentity, provider: database.provider, loggingAvailable: database.loggingAvailable });
    } catch (error) {
      log.error('power-tool.health.failed', { failure: safeError(error) });
      return send(response, 503, { ok: false, serviceVersion: SERVICE_VERSION, diagnostics: runtimeIdentity, code: String(error.code || ''), error: String(error.message).slice(0, 200) });
    }
  }
  if (request.method !== 'POST') return send(response, 404, { error: 'Not found' });
  const operation = path.replace('/api/power-tool/', '');
  if (!['read', 'write', 'log'].includes(operation) || !path.startsWith('/api/power-tool/')) {
    return send(response, 404, { error: 'Not found' });
  }
  await ready();
  const payload = await body(request);
  if (operation === 'write' && (!payload?.before || !payload?.after)) return send(response, 400, { error: 'Original and updated state required' });
  const collectionCounts = state => Object.fromEntries(['categories', 'legacyCategories', 'staffAccounts', 'requests', 'items']
    .map(key => [key, Array.isArray(state?.[key]) ? state[key].length : 0]));
  addLogContext({ ...databaseContext(), ...(operation === 'write' ? {
    originalCounts: collectionCounts(payload.before), updatedCounts: collectionCounts(payload.after),
  } : {}) });
  log.info('power-tool.operation.started');
  const result = operation === 'read' ? await readDb()
    : operation === 'write' ? await writeRemoteDb(payload.after, payload.before)
      : await recordPowerToolLog(payload?.entry);
  return send(response, 200, { ok: true, result });
});
