import { body, listen, send } from './http.js';
import { createSapRepository } from './dockflow/sap-postgres.js';
import { addLogContext, databaseContext, log, operationSummary, runtimeIdentity, safeError, SERVICE_VERSION } from './logger.js';

const repositories = {
  DRESSINGS: createSapRepository('DRESSINGS'),
  SAVOURY: createSapRepository('SAVOURY'),
};
const methods = new Set(['describe', 'sync', 'page', 'byKeys', 'all', 'forShipment', 'forClearance', 'add', 'save']);
log.info('service.started', { ...databaseContext(), sourceTables: [process.env.POSTGRES_SAP_DRESSINGS_TABLE || 'SAPAnalysisDressings', process.env.POSTGRES_SAP_SAVOURY_TABLE || 'SAPAnalysisSavoury'], schemaMapping: 'existing-columns-only', automaticMigration: false });

listen(process.env.PORT || 8081, async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/api/dockflow/health' && request.method === 'GET') {
    const status = {};
    for (const [area, repository] of Object.entries(repositories)) {
      try { const page = await repository.page(0, 1); status[area] = { ok: true, ...page.source, columns: page.columns.map(column => column[3]), hasRecords: page.rows.length > 0 }; }
      catch (error) {
        log.error('sap.health.failed', { area, failure: safeError(error) });
        status[area] = { ok: false, code: String(error.code || ''), error: String(error.message).slice(0, 200) };
      }
    }
    const ok = Object.values(status).every(item => item.ok);
    return send(response, ok ? 200 : 503, { ok, serviceVersion: SERVICE_VERSION, diagnostics: runtimeIdentity, areas: status });
  }
  const match = /^\/api\/dockflow\/sap\/(DRESSINGS|SAVOURY)\/(describe|sync|page|byKeys|all|forShipment|forClearance|add|save)$/.exec(path);
  if (!match || request.method !== 'POST') return send(response, 404, { error: 'Not found' });
  const payload = await body(request);
  if (!Array.isArray(payload?.args) || payload.args.length > 4 || !methods.has(match[2])) {
    return send(response, 400, { error: 'Invalid operation' });
  }
  addLogContext({ ...databaseContext(), table: match[1] === 'SAVOURY'
    ? process.env.POSTGRES_SAP_SAVOURY_TABLE || 'SAPAnalysisSavoury'
    : process.env.POSTGRES_SAP_DRESSINGS_TABLE || 'SAPAnalysisDressings',
    ...operationSummary(match[2], payload.args) });
  log.info('sap.operation.started');
  const result = await repositories[match[1]][match[2]](...payload.args);
  return send(response, 200, { ok: true, result: result ?? null });
});
