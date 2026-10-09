import pg from 'pg';
import { instrumentPool } from './utils/database-logging.js';

const rawTimeTypes = new Set([1082,1083,1114]);
const types = { getTypeParser(oid, format) { return rawTimeTypes.has(oid) ? value => value : pg.types.getTypeParser(oid, format); } };
export function createPool({ connection, poolMax, statementTimeoutMs, logFields }) {
  return instrumentPool(new pg.Pool({ ...connection, types, max: poolMax, idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000, query_timeout: statementTimeoutMs, statement_timeout: statementTimeoutMs,
    application_name: 'dockflow-services-' + logFields.application }), logFields);
}
export async function ping(pool) { await pool.query('SELECT 1'); }
export function createPools(config) { return { dockflow: createPool(config.dockflow), powerTool: createPool(config.powerTool) }; }
