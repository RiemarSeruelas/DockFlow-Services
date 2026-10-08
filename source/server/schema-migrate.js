import pg from 'pg';
import { sapColumns, savouryColumns } from './dockflow/sap-postgres.js';

// Read-only by default. --apply requires a verified external database backup.
const target = process.argv[2];
const apply = process.argv.includes('--apply');
if (!['sap', 'power-tool'].includes(target)) throw new Error('Usage: node server/schema-migrate.js sap|power-tool [--apply]');
if (apply && process.env.SCHEMA_BACKUP_VERIFIED !== 'YES') throw new Error('Verify an external pg_dump backup, then set SCHEMA_BACKUP_VERIFIED=YES for --apply.');
const ident = value => {
  if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(value)) throw new Error('Invalid database identifier.');
  return `"${value}"`;
};
const schema = process.env.POSTGRES_SCHEMA || (target === 'sap' ? 'Analysis' : 'power_tool');
const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: true } : false,
  connectionTimeoutMillis: 5000,
});
const client = await pool.connect();
const columnsFor = async table => new Map((await client.query(
  'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',
  [schema, table],
)).rows.map(row => [row.column_name, row.data_type]));
const qualified = table => `${ident(schema)}.${ident(table)}`;

async function inspectSap() {
  const results = [];
  for (const [table, fields, base] of [
    [process.env.POSTGRES_SAP_DRESSINGS_TABLE || 'SAPAnalysisDressings', sapColumns, ['id', 'record_key', 'shipment_id', 'supplier', 'revision', 'verified', 'updated_at', 'cell_formats', 'row_height', 'row_hidden']],
    [process.env.POSTGRES_SAP_SAVOURY_TABLE || 'SAPAnalysisSavoury', savouryColumns, ['id', 'record_key', 'updated_at']],
  ]) {
    const columns = await columnsFor(table);
    if (!columns.size) throw new Error(`Existing ${schema}.${table} table not found. No empty table will be created.`);
    if (!['integer', 'bigint'].includes(columns.get('id'))) throw new Error(`${schema}.${table} needs a numeric id column; review its existing schema.`);
    const missing = [...base, ...fields.map(([, , , name]) => name)].filter(column => !columns.has(column));
    if (missing.length) throw new Error(`${schema}.${table} is missing source columns: ${missing.join(', ')}. Check that this is the correct company database.`);
    const privileges = await client.query(`SELECT has_table_privilege(current_user, $1, 'SELECT') AS can_read,
      has_table_privilege(current_user, $1, 'UPDATE') AS can_edit,
      has_table_privilege(current_user, $1, 'INSERT') AS can_insert`, [qualified(table)]);
    const dressings = table === (process.env.POSTGRES_SAP_DRESSINGS_TABLE || 'SAPAnalysisDressings');
    if (!privileges.rows[0].can_read || !privileges.rows[0].can_edit || (dressings && !privileges.rows[0].can_insert)) {
      throw new Error(`${schema}.${table} needs SELECT and ${dressings ? 'INSERT/UPDATE' : 'UPDATE'} grants for the workstation account.`);
    }
    const counts = await client.query(`SELECT COUNT(*)::bigint AS rows, COUNT(DISTINCT id)::bigint AS ids, COUNT(id)::bigint AS nonnull_ids FROM ${qualified(table)}`);
    const count = counts.rows[0];
    if (count.rows !== count.ids || count.rows !== count.nonnull_ids) throw new Error(`${schema}.${table} has null or duplicate ids; record keys cannot be safely backfilled.`);
    if (columns.has('record_key')) {
      const keys = await client.query(`SELECT COUNT(*)::bigint AS total, COUNT(DISTINCT record_key)::bigint AS keys, COUNT(*) FILTER (WHERE record_key IS NULL OR record_key = '')::bigint AS blanks FROM ${qualified(table)}`);
      if (keys.rows[0].keys !== keys.rows[0].total || keys.rows[0].blanks !== '0') throw new Error(`${schema}.${table} has duplicate or blank record keys; review the rows before migration.`);
    }
    results.push({ table: `${schema}.${table}`, existingRows: count.rows, columns: fields.length, missing });
  }
  return results;
}

async function applySap(inspected) {
  void inspected;
  // These are existing, differently shaped source tables. Schema changes must be
  // designed against the live database separately; never add Dressings fields to Savoury.
  throw new Error('SAP schema check is read-only. Do not apply a generic migration to the company source tables.');
}

async function inspectPowerTool() {
  const tables = ['power_tool_meta', 'power_tool_usage', 'power_tool_categories', 'power_tool_legacy_categories', 'power_tool_staff_accounts', 'power_tool_requests', 'power_tool_items', 'power_tool_logs'];
  const missing = [];
  for (const table of tables) if (!(await columnsFor(table)).size) missing.push(table);
  if (missing.some(table => table !== 'power_tool_logs')) throw new Error(`Missing ${schema} tables: ${missing.join(', ')}. Review the existing Power Tool source before migrating.`);
  const meta = await client.query(`SELECT 1 FROM ${qualified('power_tool_meta')} WHERE singleton=true`);
  if (!meta.rowCount) throw new Error('No existing Power Tool metadata. Do not initialize an empty database over your current data.');
  const alternatives = await client.query("SELECT table_schema FROM information_schema.tables WHERE table_name='power_tool_logs' AND table_schema <> $1", [schema]);
  if (missing.length && alternatives.rowCount) throw new Error(`Other schemas have power_tool_logs (${alternatives.rows.map(row => row.table_schema).join(', ')}). Review/migrate those logs first.`);
  return { schema, missing, existingPowerToolData: true };
}

async function applyPowerTool(result) {
  if (!result.missing.length) return;
  const table = qualified('power_tool_logs');
  await client.query(`CREATE TABLE ${table} (
    id BIGSERIAL PRIMARY KEY, event_type TEXT NOT NULL, event_key TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '', ip_address TEXT NOT NULL DEFAULT 'unknown',
    request_path TEXT NOT NULL DEFAULT '', request_method TEXT NOT NULL DEFAULT '',
    response_status INTEGER NOT NULL DEFAULT 200, user_agent TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '', details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT power_tool_logs_event_key_unique UNIQUE (event_type, event_key)
  )`);
  await client.query(`CREATE INDEX power_tool_logs_created_at_idx ON ${table} (created_at DESC)`);
  await client.query(`CREATE INDEX power_tool_logs_event_type_idx ON ${table} (event_type, created_at DESC)`);
  await client.query(`CREATE INDEX power_tool_logs_ip_address_idx ON ${table} (ip_address, created_at DESC)`);
}

try {
  if (!apply) {
    const result = target === 'sap' ? await inspectSap() : await inspectPowerTool();
    console.log(JSON.stringify({ mode: 'check', target, result }, null, 2));
  } else {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dockflow:${target}:${schema}:schema-v1`]);
    const before = target === 'sap' ? await inspectSap() : await inspectPowerTool();
    if (target === 'sap') await applySap(before); else await applyPowerTool(before);
    await client.query('COMMIT');
    const after = target === 'sap' ? await inspectSap() : await inspectPowerTool();
    console.log(JSON.stringify({ mode: 'applied', target, before, after }, null, 2));
  }
} catch (error) {
  if (apply) await client.query('ROLLBACK').catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
