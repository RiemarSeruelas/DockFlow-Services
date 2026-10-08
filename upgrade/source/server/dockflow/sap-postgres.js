import { databaseContext, log, safeError, SERVICE_VERSION } from '../logger.js';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isIP } from 'node:net';
import { clientAddress, inNetworks } from './client-network.js';
import { fail } from './receiving.js';
import { calculateOtifPercent } from './receiving.js';
import { calculateInFullPercent } from './receiving.js';

// key, worksheet heading, default width, PostgreSQL column, source section
export const sapColumns = [
  ['deliveryDate', 'DELIVERY DATE/TIME', 23, 'delivery_date', 'system'],
  ['encodedBy', 'ENCODED BY', 20, 'encoded_by', 'sap'],
  ['item', 'MATERIAL CODE', 18, 'item', 'sap'],
  ['description', 'MATERIAL DESCRIPTION', 40, 'description', 'sap'],
  ['drNumber', 'DR NUMBER', 18, 'dr_number', 'sap'],
  ['quantity', 'DR QUANTITY', 15, 'quantity', 'sap'],
  ['poNumber', 'PO NUMBER', 19, 'po_number', 'sap'],
  ['batch', 'SAP BATCH', 20, 'batch', 'sap'],
  ['breakdown', 'BREAKDOWN', 24, 'breakdown', 'sap'],
  ['mfgDate', 'MANUFACTURING DATE', 20, 'mfg_date', 'sap'],
  ['expDate', 'EXPIRATION DATE', 18, 'exp_date', 'sap'],
  ['matdoc', 'MATERIAL DOCUMENT', 22, 'matdoc', 'sap'],
  ['supplierLot', "SUPPLIER'S LOT", 22, 'supplier_lot', 'sap'],
  ['remarks', 'REMARKS', 32, 'remarks', 'sap'],
  ['supplierName', 'SUPPLIER', 24, 'supplier_name', 'scheduling'],
  ['plateNumber', 'PLATE NO.', 16, 'plate_number', 'scheduling'],
  ['driverName', 'DRIVER NAME', 22, 'driver_name', 'scheduling'],
  ['gateIn', 'GATE IN', 22, 'gate_in', 'system'],
  ['gateOut', 'GATE OUT', 22, 'gate_out', 'system'],
  ['destination', 'DESTINATION', 22, 'destination', 'shared'],
  ['gatepassNumber', 'GATEPASS NUMBER', 20, 'gatepass_number', 'sap'],
  ['inventoryController', 'INVENTORY CONTROLLER', 24, 'inventory_controller', 'warehouse'],
  ['receivingController', 'RECEIVING CONTROLLER', 24, 'receiving_controller', 'warehouse'],
  ['helperCount', 'NO. OF HELPER', 16, 'helper_count', 'warehouse'],
  ['truckType', 'TYPE OF TRUCK', 18, 'truck_type', 'warehouse'],
  ['actualReceived', 'ACTUAL QUANTITY RECEIVED', 24, 'actual_received', 'warehouse'],
  ['onTime', 'ON TIME', 14, 'on_time', 'system'],
  ['inFull', 'IN FULL', 14, 'in_full', 'system'],
  ['otif', 'OTIF', 14, 'otif', 'system'],
  ['palletCount', 'NO. OF PALLETS', 17, 'pallet_count', 'warehouse'],
  ['warehouseRemarks', 'WAREHOUSE REMARKS', 30, 'warehouse_remarks', 'warehouse'],
  ['startUnloading', 'START UNLOADING', 22, 'start_unloading', 'system'],
  ['endUnloading', 'END UNLOADING', 22, 'end_unloading', 'system'],
  ['qaStart', 'QA INSPECTION (START)', 23, 'qa_start', 'warehouse'],
  ['qaEnd', 'QA INSPECTION (END)', 23, 'qa_end', 'warehouse'],
  ['qaDisposition', 'QA DISPOSITION', 20, 'qa_disposition', 'warehouse'],
];

export const savouryColumns = [
  ['sourceBatch', 'SOURCE BATCH', 24, 'source_batch', 'system'], ['sourceSheet', 'SOURCE SHEET', 24, 'source_sheet', 'system'],
  ['sourceRow', 'SOURCE ROW', 12, 'source_row', 'system'], ['sectionIndex', 'SECTION', 12, 'section_index', 'system'],
  ['materialType', 'MATERIAL TYPE', 17, 'material_type', 'sap'], ['std', 'STD', 16, 'std', 'sap'],
  ['classification', 'CLASSIFICATION', 22, 'classification', 'sap'], ['rol', 'ROL', 14, 'rol', 'sap'],
  ['totalWeight', 'TOTAL WEIGHT', 18, 'total_weight', 'sap'], ['week', 'WEEK', 14, 'week', 'sap'],
  ['date', 'DATE', 18, 'date', 'sap'], ['type', 'TYPE', 18, 'type', 'sap'],
  ['supplier', 'SUPPLIER', 26, 'supplier', 'sap'], ['itemCode', 'MATERIAL CODE', 20, 'item_code', 'sap'],
  ['description', 'DESCRIPTION', 38, 'description', 'sap'], ['uom', 'UOM', 12, 'uom', 'sap'],
  ['scheduledQty', 'SCHEDULED QTY', 20, 'scheduled_qty', 'sap'], ['scheduledDate', 'SCHEDULED DATE', 20, 'scheduled_date', 'sap'],
  ['time', 'TIME', 16, 'time', 'sap'], ['actualQty', 'ACTUAL QTY', 18, 'actual_qty', 'warehouse'],
  ['drNumber', 'DR NUMBER', 19, 'dr_number', 'sap'], ['expirationDate', 'EXPIRATION DATE', 20, 'expiration_date', 'sap'],
  ['batchNoLotNo', 'BATCH / LOT', 22, 'batch_no_lot_no', 'sap'], ['plateNo', 'PLATE NO.', 18, 'plate_no', 'warehouse'],
  ['timeReceived', 'TIME RECEIVED', 19, 'time_received', 'warehouse'],
  ['timeStartUnloading', 'START UNLOADING', 21, 'time_start_unloading', 'warehouse'],
  ['finishedUnloading', 'FINISHED UNLOADING', 21, 'finished_unloading', 'warehouse'],
  ['totalUnloadingTime', 'UNLOADING TIME', 19, 'total_unloading_time', 'warehouse'],
  ['timeWaitingToUnload', 'WAITING TO UNLOAD', 21, 'time_waiting_to_unload', 'warehouse'],
  ['balance', 'BALANCE', 16, 'balance', 'warehouse'], ['status', 'STATUS', 18, 'status', 'warehouse'],
  ['remarks', 'REMARKS', 32, 'remarks', 'sap'],
];
export const sapColumnsFor = area => area === 'SAVOURY' ? savouryColumns : sapColumns;
const sapFields = ['destination', 'encodedBy', 'item', 'description', 'drNumber', 'gatepassNumber', 'quantity', 'poNumber', 'batch', 'breakdown', 'mfgDate', 'expDate', 'matdoc', 'supplierLot', 'remarks'];
const warehouseFields = ['inventoryController', 'receivingController', 'helperCount', 'truckType', 'actualReceived', 'palletCount', 'warehouseRemarks', 'qaStart', 'qaEnd', 'qaDisposition'];
const adminFields = [...new Set([...sapFields, ...warehouseFields])];

export function sapEditableColumns(role, area = 'DRESSINGS') {
  if (role === 'sap') return sapColumnsFor(area).map(([key]) => key);
  if (area === 'SAVOURY') {
    if (role === 'admin' || role === 'warehouse') return savouryColumns.filter(([, , , , section]) => section !== 'system').map(([key]) => key);
    if (role === 'sap' || role === 'plc') return savouryColumns.filter(([, , , , section]) => section === 'sap').map(([key]) => key);
    return [];
  }
  if (role === 'admin' || role === 'warehouse') return adminFields;
  if (role === 'sap' || role === 'plc') return sapFields;
  if (role === 'planner') return ['destination'];
  return [];
}

export function sapCanFormat(role, area = 'DRESSINGS') {
  // Savoury formatting is persisted by the Ubuntu app without a schema migration.
  return role === 'sap' || role === 'plc' || role === 'admin' || role === 'warehouse';
}

export function encodedByName(name) {
  const parts = String(name || 'SAP Analyst').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || 'SAP Analyst';
  return `${parts[0][0].toUpperCase()}. ${parts.at(-1)}`;
}

export function calculateOtifValues(onTime, quantity, actualReceived) {
  const scheduledResult = onTime === true || onTime === 'Yes' ? 'Yes' : onTime === false || onTime === 'No' ? 'No' : '';
  const expected = Number(quantity);
  const actual = Number(actualReceived);
  const hasQuantities = String(quantity ?? '').trim() !== '' && String(actualReceived ?? '').trim() !== '' && Number.isFinite(expected) && Number.isFinite(actual) && expected >= 0 && actual >= 0;
  const inFull = hasQuantities ? (actual >= expected ? 'Yes' : 'No') : '';
  const inFullPercent = calculateInFullPercent(quantity, actualReceived);
  const otif = scheduledResult && inFull ? (scheduledResult === 'Yes' && inFull === 'Yes' ? 'Yes' : 'No') : '';
  const otifPercent = calculateOtifPercent(onTime, quantity, actualReceived);
  return { onTime: scheduledResult, inFull, inFullPercent: inFullPercent === null ? '' : inFullPercent, otif, otifPercent: otifPercent === null ? '' : otifPercent };
}

const identifier = value => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('Invalid SAP schema/table identifier');
  return `"${value}"`;
};

const runtimeHostFile = String(process.env.SAP_RUNTIME_CONFIG_FILE || '').trim();
const repositories = new Set();
export function validateSapDatabaseHost(value) {
  const host = String(value || '').trim();
  const [first, second] = host.split('.').map(Number);
  if (isIP(host) !== 4 || !(first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168))) {
    throw new Error('databaseHost must be a private IPv4 address.');
  }
  return host;
}

let runtimeHost = String(process.env.POSTGRES_HOST || '').trim();
if (runtimeHostFile && process.env.AGILE_WIFI_ENDPOINT_MODE !== 'fixed') {
  try {
    runtimeHost = validateSapDatabaseHost(JSON.parse(readFileSync(runtimeHostFile, 'utf8')).databaseHost);
  } catch (error) {
    if (error?.code !== 'ENOENT') log.warn('sap.saved_endpoint.invalid', { failure: safeError(error) });
  }
}
export const getRuntimeSapHost = () => runtimeHost;

export async function probeSapConnection() {
  if (process.env.SAP_STORAGE === 'json' || !runtimeHost || !process.env.POSTGRES_PASSWORD) return false;
  const client = new pg.Client({
    host: runtimeHost,
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || 'DockFlow',
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    connectionTimeoutMillis: 2000,
    ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: true } : false,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function switchRuntimeSapHost(value) {
  const nextHost = validateSapDatabaseHost(value);
  if (nextHost === runtimeHost) return { changed: false };
  if (runtimeHostFile) {
    await mkdir(dirname(runtimeHostFile), { recursive: true });
    const temporary = `${runtimeHostFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ databaseHost: nextHost, updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
      await rename(temporary, runtimeHostFile);
      await chmod(runtimeHostFile, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  runtimeHost = nextHost;
  for (const switchRepository of repositories) switchRepository(nextHost);
  log.info('sap.endpoint.changed');
  return { changed: true };
}

export function sapNetworkAllowed(request) {
  if (String(process.env.SAP_NETWORK_RESTRICTION_ENABLED || 'false').trim().toLowerCase() !== 'true') return true;
  return inNetworks(clientAddress(request, process.env.SAP_TRUSTED_PROXY_CIDRS), process.env.SAP_ALLOWED_CIDRS);
}

const cleanFormats = formats => {
  if (!formats || typeof formats !== 'object' || Array.isArray(formats)) return {};
  return Object.fromEntries(Object.entries(formats).filter(([key, value]) => sapColumns.some(([column]) => column === key) && value && typeof value === 'object' && !Array.isArray(value)));
};

// Each area keeps its existing source schema. Only columns reported by
// PostgreSQL are selected or written; optional DockFlow fields are not required.
export function createSapRepository(area = 'DRESSINGS') {
  if (!['DRESSINGS', 'SAVOURY'].includes(area)) fail('Unknown receiving area', 400);
  return createSourceRepository(area);
}

function createSourceRepository(area) {
  const sourceColumns = sapColumnsFor(area);
  const jsonTrial = process.env.SAP_STORAGE === 'json';
  const schema = process.env.POSTGRES_SCHEMA || 'Analysis';
  const tableName = area === 'SAVOURY'
    ? process.env.POSTGRES_SAP_SAVOURY_TABLE || 'SAPAnalysisSavoury'
    : process.env.POSTGRES_SAP_DRESSINGS_TABLE || 'SAPAnalysisDressings';
  const table = `${identifier(schema)}.${identifier(tableName)}`;
  const makePool = host => !jsonTrial && host && process.env.POSTGRES_PASSWORD ? new pg.Pool({
    host, port: Number(process.env.POSTGRES_PORT || 5432), database: process.env.POSTGRES_DB || 'DockFlow',
    user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD,
    max: 3, connectionTimeoutMillis: 2500, query_timeout: 15000,
    ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: true } : false,
  }) : null;
  let pool = makePool(runtimeHost);
  pool?.on('error', error => log.error('sap.pool.failed', { area, schema, table: tableName, failure: safeError(error) }));
  let ready;
  const types = new Map();
  const synced = new Map();
  repositories.add(host => {
    const previous = pool;
    pool = makePool(host);
    pool?.on('error', error => log.error('sap.pool.failed', { area, schema, table: tableName, failure: safeError(error) }));
    ready = undefined;
    types.clear();
    synced.clear();
    if (previous) void previous.end().catch(() => {});
  });
  const initialize = async () => {
    if (!pool) fail('SAP database is not configured', 503);
    if (!ready) ready = (async () => {
      const result = await pool.query(
        'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',
        [schema, tableName],
      );
      types.clear();
      for (const column of result.rows) types.set(column.column_name, column.data_type);
      if (!types.size) throw Object.assign(new Error(`Receiving Records table ${schema}.${tableName} was not found or is not accessible.`), { status: 503, code: 'SAP_TABLE_MISSING' });
      const missing = ['id', 'record_key'].filter(column => !types.has(column));
      if (missing.length) throw Object.assign(new Error(`Receiving Records table ${schema}.${tableName} needs stable row identifiers: ${missing.join(', ')}.`), { status: 503, code: 'SAP_ROW_ID_MISSING' });
      log.info('sap.schema_inspected', { ...databaseContext(), area, schema, table: tableName,
        columnCount: types.size, existingColumns: [...types.keys()],
        mappedColumns: sourceColumns.filter(([, , , db]) => types.has(db)).map(([, , , db]) => db),
        missingOptionalColumns: sourceColumns.filter(([, , , db]) => !types.has(db)).map(([, , , db]) => db),
        stableIdentifiersPresent: true });
    })().catch(error => {
      log.error('sap.schema_inspection.failed', { ...databaseContext(), area, schema, table: tableName, failure: safeError(error) });
      ready = undefined;
      throw error;
    });
    await ready;
  };
  const columns = () => sourceColumns.filter(([, , , db]) => types.has(db));
  const canFormat = () => area === 'DRESSINGS' && ['cell_formats', 'row_height', 'row_hidden'].every(db => types.has(db));
  const metadata = () => ({
    columns: columns(), canFormat: canFormat(),
    source: { worksheetVersion: '13.1', area, schema, table: tableName, serviceVersion: SERVICE_VERSION, missingOptionalColumns: sourceColumns.filter(([, , , db]) => !types.has(db)).map(([, , , db]) => db) },
  });
  const revisionSql = () => types.has('revision') ? identifier('revision') : 'xmin::text::bigint';
  const select = () => {
    const dbColumns = [...new Set(['id', 'record_key', 'shipment_id', 'supplier', 'revision', 'verified', 'updated_at', 'cell_formats', 'row_height', 'row_hidden', ...columns().map(([, , , db]) => db)])].filter(db => types.has(db));
    return `SELECT ${dbColumns.map(identifier).join(', ')}, ${revisionSql()} AS dockflow_revision FROM ${table}`;
  };
  const textValue = value => value instanceof Date ? value.toISOString() : String(value ?? '');
  const trueValue = value => value === true || /^(true|t|1)$/i.test(String(value));
  const decode = row => ({
    key: String(row.record_key), shipmentId: textValue(row.shipment_id), supplier: textValue(row.supplier || row.supplier_name),
    order: Number(row.id), revision: Number(row.dockflow_revision ?? row.revision ?? 0), updatedAt: textValue(row.updated_at), verified: trueValue(row.verified),
    values: Object.fromEntries(columns().map(([key, , , db]) => [key, textValue(row[db] ?? (key === 'supplierName' ? row.supplier : ''))])),
    formats: canFormat() ? cleanFormats(row.cell_formats) : {}, rowHeight: row.row_height == null ? null : Number(row.row_height), rowHidden: trueValue(row.row_hidden),
  });
  const sourceValue = (db, value) => {
    const text = textValue(value);
    return !text && !['text', 'character varying', 'character'].includes(types.get(db)) ? null : text;
  };
  const rowsFor = async (where, args) => (await pool.query(`${select()} ${where}`, args)).rows.map(decode);

  // Only approved worksheet fields enter SQL. Values remain bound parameters.
  const numberFields = new Set(['quantity','actualReceived','scheduledQty','actualQty','totalWeight','helperCount','palletCount','sourceRow','sectionIndex','balance','std','rol']);
  const dateFields = new Set(['deliveryDate','mfgDate','expDate','date','scheduledDate','expirationDate','gateIn','gateOut','startUnloading','endUnloading','qaStart','qaEnd','time','timeReceived','timeStartUnloading','finishedUnloading']);
  const numberSql = value => `CASE WHEN ${value} ~ '^[+-]?(?:[0-9]+(?:\\.[0-9]+)?|[0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]+)?)$' THEN REPLACE(${value}, ',', '')::numeric END`;
  const sortSql = (field, direction) => {
    const value = `NULLIF(BTRIM(${identifier(field[3])}::text), '')`;
    const tie = `id ${direction}`;
    if (numberFields.has(field[0])) return {join:'', order:`${numberSql(value)} ${direction} NULLS LAST, ${tie}`};
    if (dateFields.has(field[0])) {
      const type = types.get(field[3]);
      if (/^(date|time|timestamp|interval)/.test(type)) return {join:'', order:`${identifier(field[3])} ${direction} NULLS LAST, ${tie}`};
      // Imported text dates may be ISO, M/D/YYYY or Manila M/D/YY, h:mm AM/PM.
      // Guard components before make_date/make_timestamp so malformed legacy text is safe.
      const iso = String.raw`^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[ T]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?$`;
      const local = String.raw`^([0-9]{1,2})/([0-9]{1,2})/([0-9]{2}|[0-9]{4})(?:,?\s+([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?\s*(AM|PM)?)?$`;
      const time = String.raw`^([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?\s*(AM|PM)?$`;
      const join = ` CROSS JOIN LATERAL (SELECT regexp_match(UPPER(${value}), '${iso}') AS iso, regexp_match(UPPER(${value}), '${local}') AS local, regexp_match(UPPER(${value}), '${time}') AS clock) AS dockflow_sort`;
      const year = "CASE WHEN iso IS NOT NULL THEN iso[1]::int WHEN LENGTH(local[3])=2 THEN CASE WHEN local[3]::int<70 THEN 2000 ELSE 1900 END+local[3]::int ELSE local[3]::int END";
      const month = 'COALESCE(iso[2], local[1])::int', day = 'COALESCE(iso[3], local[2])::int';
      const rawHour = 'COALESCE(iso[4], local[4], \'0\')::int';
      const hour = `CASE WHEN local[7] IS NOT NULL THEN (${rawHour}%12)+CASE WHEN local[7]='PM' THEN 12 ELSE 0 END ELSE ${rawHour} END`;
      const minute = "COALESCE(iso[5], local[5], '0')::int", second = "COALESCE(iso[6], local[6], '0')::int";
      const offset = "CASE WHEN iso[7]='Z' THEN 0 WHEN iso[7] ~ '^[+-]' THEN (CASE WHEN LEFT(iso[7],1)='-' THEN -1 ELSE 1 END)*(SUBSTRING(iso[7],2,2)::int*60+RIGHT(iso[7],2)::int) ELSE 480 END";
      const date = `CASE WHEN (${year}) BETWEEN 1 AND 9999 AND (${month}) BETWEEN 1 AND 12 THEN CASE WHEN (${day}) BETWEEN 1 AND EXTRACT(DAY FROM make_date((${year}),(${month}),1)+INTERVAL '1 month - 1 day') AND (${hour}) BETWEEN 0 AND 23 AND (${minute}) BETWEEN 0 AND 59 AND (${second}) BETWEEN 0 AND 59 THEN EXTRACT(EPOCH FROM make_timestamp((${year}),(${month}),(${day}),(${hour}),(${minute}),(${second})) AT TIME ZONE 'UTC')-(${offset})*60 END END`;
      const clockHour = "CASE WHEN clock[4] IS NULL THEN clock[1]::int ELSE (clock[1]::int%12)+CASE WHEN clock[4]='PM' THEN 12 ELSE 0 END END";
      const clock = `CASE WHEN (${clockHour}) BETWEEN 0 AND 23 AND clock[2]::int BETWEEN 0 AND 59 AND COALESCE(clock[3],'0')::int BETWEEN 0 AND 59 THEN (${clockHour})*3600+clock[2]::int*60+COALESCE(clock[3],'0')::int END`;
      return {join, order:`CASE WHEN iso IS NOT NULL OR local IS NOT NULL THEN (${date}) WHEN clock IS NOT NULL THEN (${clock}) END ${direction} NULLS LAST, ${tie}`};
    }
    const numericCode = ['batch','batchNoLotNo','drNumber','poNumber','item','itemCode'].includes(field[0]);
    return {join:'', order:`${numericCode ? `${numberSql(value)} ${direction} NULLS LAST, ` : ''}LOWER(${value}) COLLATE "C" ${direction} NULLS LAST, ${tie}`};
  };

  const recalculate = async (client, keys, preserve = []) => {
    if (!['quantity', 'actual_received', 'on_time'].every(db => types.has(db))) return;
    const numeric = db => `NULLIF(BTRIM(${identifier(db)}::text), '') ~ '^[0-9]+(?:\\.[0-9]+)?$'`;
    const valid = `${numeric('quantity')} AND ${numeric('actual_received')}`;
    const full = `${identifier('actual_received')}::numeric >= ${identifier('quantity')}::numeric`;
    const assignments = [];
    if (types.has('in_full') && !preserve.includes('inFull')) assignments.push(`in_full=CASE WHEN ${valid} THEN CASE WHEN ${full} THEN 'Yes' ELSE 'No' END ELSE '' END`);
    if (types.has('otif') && !preserve.includes('otif')) assignments.push(`otif=CASE WHEN on_time IN ('Yes','No') AND ${valid} THEN CASE WHEN on_time='Yes' AND ${full} THEN 'Yes' ELSE 'No' END ELSE '' END`);
    if (assignments.length) await client.query(`UPDATE ${table} SET ${assignments.join(', ')} WHERE record_key=ANY($1::text[])`, [keys]);
  };
  return {
    jsonTrial,
    async describe() { await initialize(); return metadata(); },
    async sync(rows) {
      await initialize();
      // The Savoury import and other source-only tables never receive booking rows.
      if (area === 'SAVOURY' || !types.has('shipment_id')) return;
      const fields = columns();
      const systemKeys = new Set(['deliveryDate', 'supplierName', 'plateNumber', 'driverName', 'gateIn', 'gateOut', 'startUnloading', 'endUnloading', 'onTime', 'inFull', 'otif']);
      const systemFields = fields.filter(([key]) => systemKeys.has(key));
      const extra = ['shipment_id', 'supplier'].filter(db => types.has(db));
      const dbColumns = [...new Set(['record_key', ...extra, ...fields.map(([, , , db]) => db)])];
      const updates = [...new Set([...extra, ...systemFields.map(([, , , db]) => db)])];
      const changed = rows.filter(row => {
        const fingerprint = JSON.stringify([row.shipmentId, row.supplier, ...systemFields.map(([key]) => row.values?.[key] ?? '')]);
        return synced.get(row.key) !== fingerprint;
      });
      if (!changed.length) return;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of changed) {
          const record = { record_key: row.key, shipment_id: row.shipmentId || null, supplier: row.supplier, ...Object.fromEntries(fields.map(([key, , , db]) => [db, sourceValue(db, row.values?.[key])])) };
          await client.query(`INSERT INTO ${table} (${dbColumns.map(identifier).join(', ')}) VALUES (${dbColumns.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT (record_key) ${updates.length ? `DO UPDATE SET ${updates.map(db => `${identifier(db)}=EXCLUDED.${identifier(db)}`).join(', ')}` : 'DO NOTHING'}`, dbColumns.map(db => record[db]));
        }
        for (const row of changed) await recalculate(client, [row.key], row.preserveCalculated || []);
        await client.query('COMMIT');
        changed.forEach(row => synced.set(row.key, JSON.stringify([row.shipmentId, row.supplier, ...systemFields.map(([key]) => row.values?.[key] ?? '')])));
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    async page(offset, limit, search = '', options = 'desc') {
      await initialize();
      offset = Math.max(0, Math.min(1000000, Math.floor(Number(offset) || 0)));
      limit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 25)));
      const config = typeof options === 'object' && options && !Array.isArray(options) ? options : { direction: options };
      if (!['asc','desc'].includes(config.direction || 'desc')) fail('Invalid sort direction', 400);
      const field = config.column ? columns().find(([key]) => key === config.column) : null;
      if (config.column && !field) fail('Invalid sort column', 400);
      if (config.filters && (typeof config.filters !== 'object' || Array.isArray(config.filters))) fail('Invalid column filters', 400);
      if (config.exclude && (!Array.isArray(config.exclude) || config.exclude.length > 100000 || config.exclude.some(key => typeof key !== 'string' || key.length > 200))) fail('Invalid excluded rows', 400);
      if (config.order && (typeof config.order !== 'object' || Array.isArray(config.order) || Object.entries(config.order).some(([key,value]) => key.length > 200 || !Number.isFinite(value) || Math.abs(value)>1e15))) fail('Invalid row order', 400);
      const args = [limit + 1, offset], conditions = [];
      const parameter = value => { args.push(value); return `$${args.length}`; };
      const literal = value => value.replace(/[\\%_]/g, character => '\\' + character);
      const term = String(search || '').trim().slice(0, 200);
      const searchable = [...new Set(['record_key', 'supplier', ...columns().map(([, , , db]) => db)])].filter(db => types.has(db));
      if (term) conditions.push(`concat_ws(' ', ${searchable.map(identifier).join(', ')}) ILIKE ${parameter(`%${literal(term)}%`)}`);
      for (const [key, value] of Object.entries(config.filters || {})) {
        const column = columns().find(([name]) => name === key);
        if (!column || typeof value !== 'string' || value.length > 200) fail('Invalid column filter', 400);
        if (value) conditions.push(`COALESCE(${identifier(column[3])}::text, '') ILIKE ${parameter(`%${literal(value)}%`)}`);
      }
      if (config.exclude?.length) conditions.push(`NOT (record_key=ANY(${parameter(config.exclude)}::text[]))`);
      const direction = config.direction === 'asc' ? 'ASC' : 'DESC';
      const ordering = field ? null : config.order && Object.keys(config.order).length ? `COALESCE((${parameter(JSON.stringify(config.order))}::jsonb->>record_key)::numeric, id)` : 'id';
      const sorted = field ? sortSql(field, direction) : {join:'', order:`${ordering} ${direction}, id ${direction}`};
      const rows = await rowsFor(`${sorted.join} ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY ${sorted.order} LIMIT $1 OFFSET $2`, args);
      return { rows: rows.slice(0, limit), hasMore: rows.length > limit, ...metadata(), sort: {column: config.column || '', direction: direction.toLowerCase()} };
    },
    async byKeys(keys) { await initialize(); return rowsFor('WHERE record_key=ANY($1::text[])', [keys]); },
    async all() { await initialize(); return rowsFor('ORDER BY id DESC', []); },
    async forShipment(id) { await initialize(); return types.has('shipment_id') ? rowsFor('WHERE shipment_id=$1 ORDER BY id', [id]) : []; },
    async forClearance(shipment) {
      await initialize();
      const conditions = [], args = [];
      if (types.has('shipment_id')) { args.push(shipment.id); conditions.push(`shipment_id=$${args.length}`); }
      for (const [db, values] of [
        [area === 'SAVOURY' ? 'item_code' : 'item', (shipment.items || []).map(item => item.materialCode)],
        ['dr_number', [shipment.drNumber, ...(shipment.items || []).map(item => item.dnNumber)]],
        ['po_number', [shipment.poNumber, ...(shipment.items || []).map(item => item.poNumber)]],
      ]) {
        const matches = [...new Set(values.flatMap(value => String(value || '').split(',')).map(value => value.trim()).filter(Boolean))];
        if (types.has(db) && matches.length) { args.push(matches); conditions.push(`${identifier(db)}::text=ANY($${args.length}::text[])`); }
      }
      if (!conditions.length) return [];
      return rowsFor(`WHERE ${conditions.join(' OR ')} ORDER BY ${types.has('shipment_id') ? 'CASE WHEN shipment_id=$1 THEN 0 ELSE 1 END, ' : ''}id DESC LIMIT 10000`, args);
    },
    async add(values, name, sourceKey) {
      await initialize();
      const fields = columns();
      const parent = /^\d+:\d+(?::|$)/.test(String(sourceKey||'')) ? String(sourceKey).split(':').slice(0,2).join(':') : '';
      const key = parent ? `${parent}:copy:${randomUUID()}` : `manual:${randomUUID()}`;
      if (area === 'SAVOURY') values = {...values,sourceBatch:`dockflow:${randomUUID()}`,sourceSheet:'DockFlow',sourceRow:1,sectionIndex:1};
      const record = { record_key: key, shipment_id: parent ? parent.split(':')[0] : null, supplier: values?.supplierName || '', ...Object.fromEntries(fields.map(([field, , , db]) => [db, sourceValue(db, field === 'encodedBy' && !sourceKey ? encodedByName(name) : values?.[field])])) };
      const dbColumns = [...new Set(['record_key', ...(types.has('shipment_id') ? ['shipment_id'] : []), ...(types.has('supplier') ? ['supplier'] : []), ...fields.map(([, , , db]) => db)])];
      await pool.query(`INSERT INTO ${table} (${dbColumns.map(identifier).join(', ')}) VALUES (${dbColumns.map((_, i) => `$${i + 1}`).join(', ')})`, dbColumns.map(db => record[db]));
      return (await rowsFor('WHERE record_key=$1', [key]))[0];
    },
    async save(rows, name, role) {
      await initialize();
      const allowed = new Set(sapEditableColumns(role, area));
      const formatAllowed = sapCanFormat(role, area) && canFormat();
      const client = await pool.connect();
      const saved = [];
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          const assignments = [], args = [];
          const set = (db, value) => { args.push(value); assignments.push(`${identifier(db)}=$${args.length}`); };
          for (const [key, , , db] of columns()) if (allowed.has(key) && Object.hasOwn(row.values || {}, key)) set(db, sourceValue(db, row.values[key]));
          if (types.has('encoded_by') && assignments.length && ['sap', 'admin', 'plc', 'warehouse'].includes(role) && !Object.hasOwn(row.values || {}, 'encodedBy')) set('encoded_by', encodedByName(name));
          if (formatAllowed && row.formats !== undefined) set('cell_formats', JSON.stringify(cleanFormats(row.formats)));
          if (formatAllowed && row.rowHeight !== undefined) set('row_height', row.rowHeight == null ? null : Math.max(20, Math.min(160, Math.round(Number(row.rowHeight)))));
          if (formatAllowed && row.rowHidden !== undefined) set('row_hidden', Boolean(row.rowHidden));
          if (!assignments.length) fail('No permitted worksheet columns exist for these changes', 403);
          if (types.has('verified') && ['sap', 'admin', 'plc', 'warehouse'].includes(role)) set('verified', Boolean(row.verified));
          if (types.has('revision')) assignments.push('revision=revision+1');
          if (types.has('updated_at')) assignments.push('updated_at=NOW()');
          args.push(row.key, Number(row.revision));
          const result = await client.query(`UPDATE ${table} SET ${assignments.join(', ')} WHERE record_key=$${args.length - 1} AND ${revisionSql()}=$${args.length} RETURNING record_key, ${revisionSql()} AS dockflow_revision`, args);
          if (!result.rowCount) fail('Worksheet changed. Reload before saving.', 409);
          await recalculate(client, [row.key], Object.keys(row.values || {}));
          saved.push({ key: String(result.rows[0].record_key), revision: Number(result.rows[0].dockflow_revision) });
        }
        await client.query('COMMIT');
        return saved;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    async close() { if (pool) await pool.end(); },
  };
}
