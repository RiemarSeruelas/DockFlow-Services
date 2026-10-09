const MIN_KEY_LENGTH = 32;

function integer(env, key, fallback, min, max, errors) {
  const value = env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
  if (!Number.isInteger(value) || value < min || value > max) { errors.push(`${key} must be an integer from ${min} to ${max}`); return fallback; }
  return value;
}
function identifier(value, name, errors) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) errors.push(`${name} must be a PostgreSQL identifier`);
  return value;
}
function databaseConfig(env, prefix, defaultDatabase, defaultSchema, errors) {
  const host = env[`${prefix}_PGHOST`] || env.PGHOST || env.COMPANY_DB_HOST;
  const user = env[`${prefix}_PGUSER`] || env[`${prefix}_COMPANY_DB_USER`] || env.PGUSER;
  const password = env[`${prefix}_PGPASSWORD`] || env[`${prefix}_COMPANY_DB_PASSWORD`] || env.PGPASSWORD;
  const database = env[`${prefix}_PGDATABASE`] || env[`${prefix}_COMPANY_DB_NAME`] || defaultDatabase;
  for (const [name, value] of Object.entries({ host, user, password })) if (!value) errors.push(`${prefix} database ${name} is required`);
  const sslRaw = String(env[`${prefix}_PGSSL`] || env.PGSSL || env.COMPANY_DB_SSL || 'false').toLowerCase();
  if (!['true','false'].includes(sslRaw)) errors.push('PGSSL must be true or false');
  const schema = identifier(env[`${prefix}_SCHEMA`] || env[`${prefix}_COMPANY_DB_SCHEMA`] || defaultSchema, `${prefix}_SCHEMA`, errors);
  const port = integer({ ...env, PGPORT: env[`${prefix}_PGPORT`] || env.PGPORT || env.COMPANY_DB_PORT }, 'PGPORT', 5432, 1, 65535, errors);
  const poolMax = integer(env, 'DB_POOL_MAX', 5, 1, 25, errors);
  const statementTimeoutMs = integer(env, 'DB_STATEMENT_TIMEOUT_MS', 15000, 1000, 60000, errors);
  return { connection: { host, port, user, password, database, ssl: sslRaw === 'true' ? { rejectUnauthorized: true } : false }, schema, poolMax, statementTimeoutMs,
    logFields: { application: prefix === 'DOCKFLOW' ? 'dockflow' : 'power-tool', databaseHost: host, databasePort: port, database, databaseAccount: user, schema, sslEnabled: sslRaw === 'true' } };
}

export function loadConfig(env = process.env) {
  const errors = [];
  const apiKeys = String(env.API_KEYS || env.COMPANY_API_KEY || '').split(',').map(key => key.trim()).filter(Boolean);
  if (!apiKeys.length || apiKeys.some(key => Buffer.byteLength(key) < MIN_KEY_LENGTH || /\s/.test(key) || /^(replace|change|your[-_])/i.test(key))) errors.push('API_KEYS (or COMPANY_API_KEY) requires a generated key of at least 32 bytes, without spaces');
  const port = integer(env, 'PORT', 5230, 1, 65535, errors);
  const dockflow = databaseConfig(env, 'DOCKFLOW', 'DockFlow', 'Analysis', errors);
  const powerTool = databaseConfig(env, 'POWER_TOOL', 'confirmation_powertool_machine', 'power_tool', errors);
  dockflow.tables = {
    DRESSINGS: identifier(env.DOCKFLOW_DRESSINGS_TABLE || env.DOCKFLOW_COMPANY_DRESSINGS_TABLE || 'SAPAnalysisDressings', 'DOCKFLOW_DRESSINGS_TABLE', errors),
    SAVOURY: identifier(env.DOCKFLOW_SAVOURY_TABLE || env.DOCKFLOW_COMPANY_SAVOURY_TABLE || 'SAPAnalysisSavoury', 'DOCKFLOW_SAVOURY_TABLE', errors),
  };
  if (env.DOCS_ENABLED && !['true','false'].includes(env.DOCS_ENABLED.toLowerCase())) errors.push('DOCS_ENABLED must be true or false');
  if (errors.length) throw new Error('Invalid configuration: ' + errors.join('; '));
  return { port, apiKeys, docsEnabled: String(env.DOCS_ENABLED || 'true').toLowerCase() !== 'false', dockflow, powerTool };
}
