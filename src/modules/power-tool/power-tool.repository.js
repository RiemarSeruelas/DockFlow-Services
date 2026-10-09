import { log, safeError } from '../../utils/logger.js';
import * as jsonStore from './power-tool.jsonDataStore.js';

// Each repository owns its state and receives its own pool. No process-wide
// database environment is switched between DockFlow and Power Tool.
export function createPowerToolRepository({ pool: suppliedPool, schema, logFields }) {
  if (!suppliedPool) throw new Error('Inject the Power Tool database pool.');
  const databaseFields = logFields;
const COLLECTIONS = {
  categories: "power_tool_categories",
  legacyCategories: "power_tool_legacy_categories",
  staffAccounts: "power_tool_staff_accounts",
  requests: "power_tool_requests",
  items: "power_tool_items"
};
const POWER_TOOL_LOGS_TABLE = "power_tool_logs";
const BASELINE = Symbol("powerToolPostgresBaseline");

const pool = suppliedPool;
let postgresLogsAvailable=true,ensurePromise,reconnectPromise;
let activeProvider='unavailable',lastPostgresConnectedAt='',lastPostgresError='';
async function observeDatabase(action) {
  if(activeProvider!=='postgresql')throw Object.assign(new Error('Power Tool PostgreSQL is unavailable.'),{code:'57P03'});
  try{return await action();}catch(error){if(postgresConnectionError(error)){activeProvider='unavailable';lastPostgresError=String(error.message||error);}throw error;}
}

function quotedIdentifier(value, label) {
  const identifier = String(value || "").trim();
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function schemaName() { return schema; }

function tableName(name) {
  return `${quotedIdentifier(schemaName(), "POSTGRES_SCHEMA")}.${quotedIdentifier(name, "PostgreSQL table name")}`;
}

function powerToolLogsTableName() {
  return `${quotedIdentifier(schemaName(), "POSTGRES_SCHEMA")}."${POWER_TOOL_LOGS_TABLE}"`;
}

function getPool() { return pool; }

function postgresConnectionError(error) {
  if (!error) return false;
  const code = String(error.code || error.cause?.code || "").trim().toUpperCase();
  const message = String(error.message || "").trim().toLowerCase();
  return code.startsWith("08")
    || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "57P01", "57P02", "57P03"].includes(code)
    || message.includes("connection terminated")
    || message.includes("connection timeout")
    || message.includes("connect econnrefused")
    || message.includes("client has already been released")
    || message.includes("cannot use a pool after calling end");
}

function serialized(value) {
  return JSON.stringify(value ?? null);
}

function collectionMap(records) {
  const map = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const id = String(record?.id || "").trim();
    if (!id) continue;
    map.set(id, serialized(record));
  }
  return map;
}

function baselineFor(db) {
  const collections = {};
  for (const key of Object.keys(COLLECTIONS)) {
    collections[key] = collectionMap(db[key]);
  }
  return {
    collections,
    meta: serialized(db.meta || {}),
    usage: structuredClone(db.usage || {})
  };
}

function attachBaseline(db) {
  Object.defineProperty(db, BASELINE, {
    value: baselineFor(db),
    configurable: true,
    enumerable: false,
    writable: false
  });
  return db;
}

function emptyUsage() {
  return {
    totalVisits: 0,
    totalQrOpens: 0,
    totalChecklistViews: 0,
    ips: {},
    sessions: {},
    events: {}
  };
}

function normalizeUsage(value) {
  const source = value && typeof value === "object" ? structuredClone(value) : {};
  return {
    totalVisits: Number(source.totalVisits || 0),
    totalQrOpens: Number(source.totalQrOpens || 0),
    totalChecklistViews: Number(source.totalChecklistViews || 0),
    ips: source.ips && typeof source.ips === "object" && !Array.isArray(source.ips) ? source.ips : {},
    sessions: source.sessions && typeof source.sessions === "object" && !Array.isArray(source.sessions) ? source.sessions : {},
    events: source.events && typeof source.events === "object" && !Array.isArray(source.events) ? source.events : {}
  };
}

function ensureIp(usage, ip, source = {}) {
  const key = String(ip || source.ip || "unknown");
  if (!usage.ips[key]) {
    usage.ips[key] = {
      ip: key,
      visits: 0,
      qrOpens: 0,
      checklistViews: 0,
      firstSeenAt: source.firstSeenAt || new Date().toISOString(),
      lastSeenAt: source.lastSeenAt || new Date().toISOString(),
      lastPath: source.lastPath || ""
    };
  }
  return usage.ips[key];
}

function laterTimestamp(left, right) {
  const leftTime = new Date(left || 0).getTime();
  const rightTime = new Date(right || 0).getTime();
  return rightTime >= leftTime ? (right || left) : left;
}

function trimObjectByDate(value, limit) {
  const entries = Object.entries(value || {});
  if (entries.length <= limit) return value || {};
  return Object.fromEntries(
    entries
      .sort((a, b) => new Date(b[1]?.lastSeenAt || b[1]?.createdAt || 0) - new Date(a[1]?.lastSeenAt || a[1]?.createdAt || 0))
      .slice(0, limit)
  );
}

function mergeUsage(storedValue, baselineValue, desiredValue) {
  const stored = normalizeUsage(storedValue);
  const baseline = normalizeUsage(baselineValue);
  const desired = normalizeUsage(desiredValue);

  for (const [sessionId, session] of Object.entries(desired.sessions)) {
    const baselineSession = baseline.sessions[sessionId];
    const storedSession = stored.sessions[sessionId];
    if (!baselineSession && !storedSession) {
      stored.sessions[sessionId] = session;
      stored.totalVisits += 1;
      ensureIp(stored, session.ip, desired.ips?.[session.ip]).visits += 1;
    } else if (baselineSession && serialized(session) !== serialized(baselineSession)) {
      stored.sessions[sessionId] = {
        ...(storedSession || baselineSession),
        ...session,
        lastSeenAt: laterTimestamp(storedSession?.lastSeenAt, session.lastSeenAt)
      };
    }
  }

  for (const sessionId of Object.keys(baseline.sessions)) {
    if (!desired.sessions[sessionId] && serialized(stored.sessions[sessionId]) === serialized(baseline.sessions[sessionId])) {
      delete stored.sessions[sessionId];
    }
  }

  for (const [eventKey, event] of Object.entries(desired.events)) {
    if (!baseline.events[eventKey] && !stored.events[eventKey]) {
      stored.events[eventKey] = event;
      const ipRecord = ensureIp(stored, event.ip, desired.ips?.[event.ip]);
      if (event.type === "qr_open") {
        stored.totalQrOpens += 1;
        ipRecord.qrOpens += 1;
      } else if (event.type === "checklist_view") {
        stored.totalChecklistViews += 1;
        ipRecord.checklistViews += 1;
      }
    }
  }

  for (const eventKey of Object.keys(baseline.events)) {
    if (!desired.events[eventKey] && serialized(stored.events[eventKey]) === serialized(baseline.events[eventKey])) {
      delete stored.events[eventKey];
    }
  }

  for (const [ip, desiredIp] of Object.entries(desired.ips)) {
    const storedIp = ensureIp(stored, ip, desiredIp);
    storedIp.firstSeenAt = storedIp.firstSeenAt || desiredIp.firstSeenAt;
    storedIp.lastSeenAt = laterTimestamp(storedIp.lastSeenAt, desiredIp.lastSeenAt);
    if (desiredIp.lastPath) storedIp.lastPath = desiredIp.lastPath;
  }

  stored.sessions = trimObjectByDate(stored.sessions, 5000);
  stored.events = trimObjectByDate(stored.events, 10000);
  return stored;
}

async function insertSingleton(client, table, value) {
  await client.query(
    `INSERT INTO ${tableName(table)} (singleton, record)
     VALUES (true, $1::jsonb)
     ON CONFLICT (singleton) DO UPDATE SET record = EXCLUDED.record, updated_at = now()`,
    [serialized(value)]
  );
}

async function ensurePostgres() {
  if (!ensurePromise) ensurePromise = (async () => {
    const client = await getPool().connect();
    try {
      const required = ["power_tool_meta", "power_tool_usage", ...Object.values(COLLECTIONS)];
      for (const table of required) {
        const found = await client.query('SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2', [schemaName(), table]);
        if (!found.rowCount) throw Object.assign(new Error(`Missing ${schemaName()}.${table}; migrate and back up the existing Power Tool data before enabling the API.`), {status:503,code:'POWER_TOOL_SCHEMA_MISSING'});
      }
      const logs = await client.query('SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2', [schemaName(), POWER_TOOL_LOGS_TABLE]);
      postgresLogsAvailable = logs.rowCount > 0;
      const existing = await client.query(`SELECT 1 FROM ${tableName("power_tool_meta")} WHERE singleton = true`);
      if (!existing.rowCount) throw Object.assign(new Error('Power Tool database has no records; migrate the existing data before enabling the API.'), {status:503,code:'POWER_TOOL_DATA_MISSING'});
    } finally { client.release(); }
  })().catch(error => { ensurePromise=undefined;throw error; });
  await ensurePromise;
}

async function readPostgresDb() {
  await ensurePostgres();
  const client = await getPool().connect();
  try {
    const [metaResult, usageResult, ...collectionResults] = await Promise.all([
      client.query(`SELECT record FROM ${tableName("power_tool_meta")} WHERE singleton = true`),
      client.query(`SELECT record FROM ${tableName("power_tool_usage")} WHERE singleton = true`),
      ...Object.values(COLLECTIONS).map((table) =>
        client.query(`SELECT record FROM ${tableName(table)} ORDER BY id`)
      )
    ]);
    const db = {
      meta: metaResult.rows[0]?.record || {},
      usage: usageResult.rows[0]?.record || emptyUsage()
    };
    Object.keys(COLLECTIONS).forEach((key, index) => {
      db[key] = collectionResults[index].rows.map((row) => row.record);
    });
    const attached = attachBaseline(db);
    const migrated = jsonStore.normalizeDb(attached);
    if (migrated.changed) {
      throw Object.assign(new Error('Power Tool database needs a reviewed migration.'),{status:503,code:'POWER_TOOL_MIGRATION_REQUIRED'});
    }
    return attached;
  } finally {
    client.release();
  }
}

async function writeCollectionChanges(client, key, desiredRecords, baseline) {
  const table = COLLECTIONS[key];
  const before = baseline?.collections?.[key] || new Map();
  const after = collectionMap(desiredRecords);

  for (const [id, record] of after) {
    if (before.get(id) === record) continue;
    if(key==='requests'){
      const expected=before.get(id)?JSON.parse(before.get(id)):null;
      if(expected?.status){
        const current=await client.query(`SELECT record FROM ${tableName(table)} WHERE id=$1 FOR UPDATE`,[id]);
        if(current.rows[0]?.record?.status!==expected.status)throw Object.assign(new Error('This inspection was already completed. Reload the existing result.'),{status:409,code:'APPROVAL_CONFLICT'});
      }
    }
    await client.query(
      `INSERT INTO ${tableName(table)} (id, record)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record, updated_at = now()`,
      [id, record]
    );
  }

  for (const id of before.keys()) {
    if (after.has(id)) continue;
    await client.query(`DELETE FROM ${tableName(table)} WHERE id = $1`, [id]);
  }
}

async function writePostgresDb(db) {
  await ensurePostgres();
  const baseline = db?.[BASELINE];
  const next = {
    ...db,
    meta: {
      ...(db.meta || {}),
      appName: "Power Tool",
      version: 12,
      updatedAt: new Date().toISOString()
    }
  };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const key of Object.keys(COLLECTIONS)) {
      await writeCollectionChanges(client, key, next[key], baseline);
    }
    if (!baseline || serialized(next.meta) !== baseline.meta) {
      await insertSingleton(client, "power_tool_meta", next.meta);
    }

    if (!baseline) {
      await insertSingleton(client, "power_tool_usage", next.usage || emptyUsage());
    } else if (serialized(next.usage || {}) !== serialized(baseline.usage || {})) {
      const currentResult = await client.query(
        `SELECT record FROM ${tableName("power_tool_usage")}
         WHERE singleton = true
         FOR UPDATE`
      );
      const merged = mergeUsage(
        currentResult.rows[0]?.record || emptyUsage(),
        baseline.usage,
        next.usage
      );
      await insertSingleton(client, "power_tool_usage", merged);
      next.usage = merged;
    }
    await client.query("COMMIT");
    return attachBaseline(next);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function limitedLogValue(value, maximum, fallback = "") {
  const normalized = String(value ?? "").trim();
  return (normalized || fallback).slice(0, maximum);
}

async function recordPostgresLog(entry = {}) {
  await ensurePostgres();
  const eventType = limitedLogValue(entry.eventType, 60);
  const eventKey = limitedLogValue(entry.eventKey, 360);
  if (!eventType || !eventKey) {
    throw new Error("Power Tool log eventType and eventKey are required.");
  }

  const values = [
    eventType,
    eventKey,
    limitedLogValue(entry.sessionId, 120),
    limitedLogValue(entry.ipAddress, 120, "unknown"),
    limitedLogValue(entry.requestPath, 500),
    limitedLogValue(entry.requestMethod, 20),
    Number.isInteger(Number(entry.responseStatus)) ? Number(entry.responseStatus) : 200,
    limitedLogValue(entry.userAgent, 1000),
    limitedLogValue(entry.targetId, 180),
    serialized(entry.details && typeof entry.details === "object" ? entry.details : {})
  ];

  const client = await getPool().connect();
  try {
    const result = await client.query(
      `INSERT INTO ${powerToolLogsTableName()} (
         event_type, event_key, session_id, ip_address, request_path,
         request_method, response_status, user_agent, target_id, details
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (event_type, event_key) DO UPDATE
       SET session_id = EXCLUDED.session_id,
           ip_address = EXCLUDED.ip_address,
           request_path = CASE
             WHEN EXCLUDED.request_path = '' THEN power_tool_logs.request_path
             ELSE EXCLUDED.request_path
           END,
           request_method = CASE
             WHEN EXCLUDED.request_method = '' THEN power_tool_logs.request_method
             ELSE EXCLUDED.request_method
           END,
           response_status = EXCLUDED.response_status,
           user_agent = CASE
             WHEN EXCLUDED.user_agent = '' THEN power_tool_logs.user_agent
             ELSE EXCLUDED.user_agent
           END,
           target_id = CASE
             WHEN EXCLUDED.target_id = '' THEN power_tool_logs.target_id
             ELSE EXCLUDED.target_id
           END,
           details = EXCLUDED.details,
           last_seen_at = now()
       RETURNING id`,
      values
    );
    return { stored: true, id: result.rows[0]?.id };
  } finally {
    client.release();
  }
}

function getDataStoreState() {
  return {provider:activeProvider,configuredProvider:'postgresql',postgresOnly:true,fallback:false,fallbackDirty:false,
    lastPostgresConnectedAt:lastPostgresConnectedAt||null,lastPostgresError:lastPostgresError||null};
}

async function initializeDataStore() { return getDataStoreState(); }

async function reconnectPostgres() {
  if(reconnectPromise)return reconnectPromise;
  reconnectPromise=(async()=>{
    try {
      await ensurePostgres();await getPool().query('SELECT 1');await readPostgresDb();
      activeProvider='postgresql';lastPostgresConnectedAt=new Date().toISOString();lastPostgresError='';
      log.info('connection.database.ready',databaseFields);return getDataStoreState();
    }catch(error){activeProvider='unavailable';lastPostgresError=String(error.message||error);log.error('connection.database.failed',{...databaseFields,failure:safeError(error)});throw error;}
  })().finally(()=>{reconnectPromise=undefined;});
  return reconnectPromise;
}

async function readDb() { return observeDatabase(readPostgresDb); }

async function writeDb(db) { return observeDatabase(()=>writePostgresDb(db)); }

async function writeRemoteDb(after, before) {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") {
    throw new Error("A PostgreSQL-only write with its original snapshot is required.");
  }
  const next = { ...after };
  Object.defineProperty(next, BASELINE, { value: baselineFor(before), enumerable: false });
  return writeDb(next);
}

async function recordPowerToolLog(entry={}) {
  if(!postgresLogsAvailable)return {stored:false,provider:'postgresql',reason:'Optional power_tool_logs table is absent'};
  return observeDatabase(()=>recordPostgresLog(entry));
}

async function checkDb() {
  return observeDatabase(async()=>{await ensurePostgres();await getPool().query('SELECT 1');return {ok:true,provider:'postgresql',schema:schemaName(),loggingAvailable:postgresLogsAvailable};});
}

async function closeDb() { await pool.end();activeProvider='unavailable';ensurePromise=undefined; }

function getDbPath() { return `PostgreSQL (schema ${schemaName()})`; }

return { getDataStoreState, initializeDataStore, reconnectPostgres, readDb, writeDb, writeRemoteDb, recordPowerToolLog, checkDb, closeDb, getDbPath };
}
