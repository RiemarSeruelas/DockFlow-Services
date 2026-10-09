import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
export const LOGGING_VERSION = '13.3-express-1';
const context = new AsyncLocalStorage();
const categories = { initialization: 'INITIALIZATION', request: 'USER_REQUEST', connection: 'CONNECTION' };
const connectionStates = new Map();
const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const secretKey = /password|passcode|secret|token|authorization|cookie|credential|api.?key/i;
const privateFields = new Set(['args', 'payload', 'body', 'rows', 'records', 'values', 'before', 'after', 'entry', 'data', 'detail', 'query', 'parameters']);
const serverRoot = fileURLToPath(new URL('../', import.meta.url));

function fingerprint() {
  const hash = createHash('sha256');
  const visit = directory => {
    for (const file of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, file.name);
      if (file.isDirectory()) visit(path);
      else if (/\.(js|mjs|json)$/.test(file.name)) hash.update(path.slice(serverRoot.length)).update(readFileSync(path));
    }
  };
  visit(serverRoot);
  hash.update(readFileSync(new URL('../../package.json', import.meta.url)));
  return hash.digest('hex').slice(0, 16);
}

export const runtimeIdentity = Object.freeze({
  service: process.env.LOG_SERVICE_NAME || 'dockflow-services',
  serviceVersion: SERVICE_VERSION,
  loggingVersion: LOGGING_VERSION,
  buildId: fingerprint(),
  workstationId: process.env.WORKSTATION_ID || 'not-configured',
  instanceId: hostname() + ':' + process.pid + ':' + randomUUID().slice(0, 8),
  hostname: hostname(),
  pid: process.pid,
});

export function safeText(value, length = 500) {
  let text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');
  const secrets = Object.entries(process.env).filter(([key, item]) => secretKey.test(key) && item?.length >= 4).map(([, item]) => item).sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b(password|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@');
  return text.slice(0, length);
}

export function safeError(error) {
  const code = safeText(error?.code || error?.cause?.code || '', 40);
  let message = safeText(error?.message || 'Service unavailable');
  // PostgreSQL detail and statement parameters can include complete data rows.
  // Keep identifiers for schema/auth failures, but hide quoted input literals.
  if (!['42703', '42P01', '42501', '28P01', '3D000', '3F000'].includes(code)) {
    message = message.replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, '[REDACTED_VALUE]');
  }
  return {
    name: safeText(error?.name || 'Error', 80), code, message,
    ...(error?.status ? { status: Number(error.status) } : {}),
    ...(error?.schema ? { schema: safeText(error.schema, 120) } : {}),
    ...(error?.table ? { table: safeText(error.table, 120) } : {}),
    ...(error?.column ? { column: safeText(error.column, 120) } : {}),
    ...(error?.constraint ? { constraint: safeText(error.constraint, 120) } : {}),
  };
}

function scrub(value, depth = 0, seen = new WeakSet()) {
  if (depth > 7) return '[TRUNCATED]';
  if (typeof value === 'string') return safeText(value, 1200);
  if (typeof value === 'bigint') return String(value);
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (value instanceof Error) return safeError(value);
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => scrub(item, depth + 1, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [safeText(key, 100),
    secretKey.test(key) || privateFields.has(key.toLowerCase()) ? '[REDACTED]' : scrub(item, depth + 1, seen)]));
}

export function withLogContext(fields, action) { return context.run(fields, action); }
export function logContext() { return context.getStore(); }
export function reportConnectionState(target, ok, fields = {}) {
  if (connectionStates.get(target) === ok) return;
  connectionStates.set(target, ok);
  log[ok ? 'info' : 'error'](ok ? 'connection.service.available' : 'connection.service.unavailable', { target, ...fields });
}

export function addLogContext(fields) {
  const current = context.getStore();
  if (current) Object.assign(current, fields);
}

export function createLogger({ identity = runtimeIdentity, writer, level } = {}) {
  const write = writer || ((entry, severity) => (severity === 'error' || severity === 'warn' ? console.error : console.log)(entry));
  return Object.fromEntries(Object.keys(levels).map(severity => [severity, (event, fields = {}) => {
    const category = categories[String(event).split('.')[0]];
    if (!category) return;
    if (category === 'USER_REQUEST' && context.getStore()?.operation === 'health') return;
    // These three requested categories stay visible even with a previous LOG_LEVEL=warn/error.
    const threshold = levels[level || 'info'] || levels.info;
    if (levels[severity] < threshold) return;
    write(JSON.stringify(scrub({ ...context.getStore(), ...fields, ...identity,
      timestamp: new Date().toISOString(), level: severity, category, event })), severity);
  }]));
}

export const log = createLogger();

export function operationSummary(operation, args) {
  if (!Array.isArray(args)) return {};
  if (operation === 'page') return {
    offset: Math.max(0, Math.min(1000000, Math.floor(Number(args[0]) || 0))),
    limit: Math.max(1, Math.min(100, Math.floor(Number(args[1]) || 25))),
    searchPresent: Boolean(args[2]), searchLength: String(args[2] || '').length,
    sort: String(typeof args[3] === 'object' ? args[3]?.direction : args[3]).toLowerCase() === 'asc' ? 'asc' : 'desc',
    sortColumn: typeof args[3]?.column === 'string' ? safeText(args[3].column, 100) : undefined,
    filterCount: args[3]?.filters && typeof args[3].filters === 'object' ? Object.keys(args[3].filters).length : 0,
  };
  const summary = {};
  if (['sync', 'save', 'byKeys'].includes(operation)) summary.recordCount = Array.isArray(args[0]) ? args[0].length : 0;
  if (operation === 'add') summary.inputFieldCount = args[0] && typeof args[0] === 'object' ? Object.keys(args[0]).length : 0;
  if (['add', 'save'].includes(operation) && args[1]) summary.declaredActor = {
    name: safeText(args[1], 120), role: operation === 'save' ? safeText(args[2], 60) : undefined,
    identitySource: 'operation argument forwarded by Ubuntu; not independently authenticated here',
  };
  return summary;
}

export function responseSummary(payload) {
  const result = payload?.result;
  const summary = {};
  if (Array.isArray(result?.rows)) summary.rowCount = result.rows.length;
  else if (Array.isArray(result)) summary.resultCount = result.length;
  if (typeof result?.hasMore === 'boolean') summary.hasMore = result.hasMore;
  if (Array.isArray(result?.columns)) summary.columnCount = result.columns.length;
  if (result?.source) summary.source = {
    area: result.source.area, schema: result.source.schema, table: result.source.table,
    mappingServiceVersion: result.source.serviceVersion,
    missingOptionalColumns: result.source.missingOptionalColumns,
  };
  if (payload?.areas) summary.areas = Object.fromEntries(Object.entries(payload.areas).map(([area, state]) => [area, {
    ok: state.ok, hasRecords: state.hasRecords, schema: state.schema, table: state.table,
    error: state.error ? safeError({ message: state.error, code: state.code }).message : undefined,
  }]));
  if (payload?.error) summary.failure = safeError({ message: payload.error, code: payload.code });
  if (typeof payload?.loggingAvailable === 'boolean') summary.loggingAvailable = payload.loggingAvailable;
  return summary;
}

