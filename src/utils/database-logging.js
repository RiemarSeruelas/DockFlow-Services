import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { log, logContext, safeError, withLogContext } from './logger.js';

const queryScope = new AsyncLocalStorage();
const instrumented = new WeakSet();
const connectionFailure = error => /^(08|ECONN|EHOST|ENET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|57P0[123]|28P01)/.test(String(error?.code || error?.cause?.code || ''));

export function statementSummary(sql, parameters = []) {
  sql = String(sql || '');
  const referenced = [...new Set([...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1])))].sort((a, b) => a - b);
  const count = Array.isArray(parameters) ? parameters.length : 0;
  return {
    statementId: createHash('sha256').update(sql).digest('hex').slice(0, 16),
    command: /\b(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|CREATE|ALTER|WITH)\b/i.exec(sql)?.[1].toUpperCase() || 'OTHER',
    parameterCount: count,
    referencedParameterPositions: referenced,
    unusedParameterPositions: Array.from({ length: count }, (_, index) => index + 1).filter(index => !referenced.includes(index)),
    missingParameterPositions: referenced.filter(index => index > count),
  };
}

// Observe both pool queries and borrowed transaction clients without changing SQL,
// results, errors, callbacks, transactions, or the number of connections.
export function instrumentPool(pool, fields = {}, { logger = log } = {}) {
  if (!pool || instrumented.has(pool)) return pool;
  instrumented.add(pool);
  let state;
  const failed = error => {
    const code = String(error?.code || error?.cause?.code || '');
    if (state === 'failed:' + code) return;
    state = 'failed:' + code;
    logger.error('connection.database.failed', { ...fields, failure: safeError(error) });
  };
  const wrapQuery = target => {
    if (!target || target.__dockflowQueryLogging) return;
    Object.defineProperty(target, '__dockflowQueryLogging', { value: true });
    const original = target.query;
    target.query = function (...args) {
      if (queryScope.getStore()) return original.apply(this, args);
      const request = logContext();
      const trace = Boolean(request?.requestId && request.operation !== 'health');
      const summary = { ...fields, queryId: randomUUID(), ...statementSummary(
        typeof args[0] === 'string' ? args[0] : args[0]?.text,
        Array.isArray(args[1]) ? args[1] : args[0]?.values,
      ) };
      const started = performance.now();
      if (trace) logger.info('request.database.started', summary);
      let finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        const durationMs = Math.round((performance.now() - started) * 100) / 100;
        if (error && connectionFailure(error)) failed(error);
        if (trace) withLogContext(request, () => logger[error ? 'error' : 'info'](error ? 'request.database.failed' : 'request.database.completed', {
          ...summary, durationMs,
          ...(error ? { failure: safeError(error) } : { rowCount: result?.rowCount ?? result?.affectedRows ?? result?.rows?.length ?? 0 }),
        }));
      };
      const callbackIndex = typeof args.at(-1) === 'function' ? args.length - 1 : -1;
      if (callbackIndex >= 0) {
        const callback = args[callbackIndex];
        args[callbackIndex] = (error, result) => {
          finish(error, result);
          return queryScope.run(false, () => withLogContext(request, () => callback(error, result)));
        };
      }
      try {
        const result = queryScope.run(true, () => original.apply(this, args));
        if (result?.then) return result.then(value => { finish(null, value); return value; }, error => { finish(error); throw error; });
        return result;
      } catch (error) { finish(error); throw error; }
    };
  };
  wrapQuery(pool);
  pool.on?.('connect', client => {
    state = 'connected';
    wrapQuery(client);
    logger.info('connection.database.connected', fields);
  });
  pool.on?.('error', failed);
  const connect = pool.connect;
  if (typeof connect === 'function') pool.connect = function (...args) {
    const callbackIndex = typeof args.at(-1) === 'function' ? args.length - 1 : -1;
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex];
      args[callbackIndex] = (error, client, release) => {
        if (error) failed(error); else wrapQuery(client);
        return callback(error, client, release);
      };
    }
    try {
      const result = connect.apply(this, args);
      if (result?.then) return result.then(client => { wrapQuery(client); return client; }, error => { failed(error); throw error; });
      return result;
    } catch (error) { failed(error); throw error; }
  };
  return pool;
}
