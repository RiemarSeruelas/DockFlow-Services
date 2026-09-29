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
  ['issued', 'ISSUED', 12, 'issued', 'sap'],
  ['rtReasoning', 'RT REASONING', 28, 'rt_reasoning', 'sap'],
  ['supplierLot', "SUPPLIER'S LOT", 22, 'supplier_lot', 'sap'],
  ['remarks', 'REMARKS', 32, 'remarks', 'sap'],
  ['weekNumber', 'WEEK NO.', 14, 'week_number', 'sap'],
  ['palletType', 'TYPE / ALLERGEN', 24, 'pallet_type', 'sap'],
  ['foilWeight', 'FOIL WEIGHT', 16, 'foil_weight', 'sap'],
  ['palletWeightKg', 'WEIGHT (KG)', 16, 'pallet_weight_kg', 'sap'],
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
  ['inFullPercent', 'IN FULL %', 15, 'in_full_percent', 'system'],
  ['otif', 'OTIF', 14, 'otif', 'system'],
  ['otifPercent', 'OTIF %', 14, 'otif_percent', 'system'],
  ['palletCount', 'NO. OF PALLETS', 17, 'pallet_count', 'warehouse'],
  ['warehouseRemarks', 'WAREHOUSE REMARKS', 30, 'warehouse_remarks', 'warehouse'],
  ['startUnloading', 'START UNLOADING', 22, 'start_unloading', 'system'],
  ['endUnloading', 'END UNLOADING', 22, 'end_unloading', 'system'],
  ['qaStart', 'QA INSPECTION (START)', 23, 'qa_start', 'warehouse'],
  ['qaEnd', 'QA INSPECTION (END)', 23, 'qa_end', 'warehouse'],
  ['qaDisposition', 'QA DISPOSITION', 20, 'qa_disposition', 'warehouse'],
];

const sapFields = ['destination', 'encodedBy', 'item', 'description', 'drNumber', 'gatepassNumber', 'quantity', 'poNumber', 'batch', 'breakdown', 'mfgDate', 'expDate', 'matdoc', 'issued', 'rtReasoning', 'supplierLot', 'remarks', 'weekNumber', 'palletType', 'foilWeight', 'palletWeightKg'];
const warehouseFields = ['inventoryController', 'receivingController', 'helperCount', 'truckType', 'actualReceived', 'palletCount', 'warehouseRemarks', 'qaStart', 'qaEnd', 'qaDisposition'];
const adminFields = [...new Set([...sapFields, ...warehouseFields])];

export function sapEditableColumns(role) {
  if (role === 'admin' || role === 'warehouse') return adminFields;
  if (role === 'sap' || role === 'plc') return sapFields;
  if (role === 'planner') return ['destination'];
  return [];
}

export function sapCanFormat(role) {
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
    if (error?.code !== 'ENOENT') console.warn('[SAP] Ignoring invalid saved database endpoint.');
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
  console.log('[SAP] Company PostgreSQL endpoint changed; rebuilding Receiving Records pools.');
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

export function createSapRepository(area = 'DRESSINGS') {
  const jsonTrial = process.env.SAP_STORAGE === 'json';
  const configured = !!process.env.POSTGRES_PASSWORD;
  const schemaName = process.env.POSTGRES_SCHEMA || 'Analysis';
  const tableName = area === 'SAVOURY'
    ? process.env.POSTGRES_SAP_SAVOURY_TABLE || 'SAPAnalysisSavoury'
    : process.env.POSTGRES_SAP_DRESSINGS_TABLE || 'SAPAnalysisDressings';
  const table = `${identifier(schemaName)}.${identifier(tableName)}`;
  const makePool = host => configured && !jsonTrial && host && host !== 'your_postgres_host' ? new pg.Pool({
    host,
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || 'DockFlow',
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    max: 3,
    connectionTimeoutMillis: 2500,
    query_timeout: 10000,
    ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: true } : false,
  }) : null;
  let pool = makePool(runtimeHost);
  pool?.on('error', () => {});
  let ready = false;
  const synced = new Map();
  repositories.add(host => {
    const previous = pool;
    pool = makePool(host);
    pool?.on('error', () => {});
    ready = false;
    synced.clear();
    if (previous) void previous.end().catch(() => {});
  });
  const systemSyncFields = ['deliveryDate', 'supplierName', 'plateNumber', 'driverName', 'gateIn', 'gateOut', 'startUnloading', 'endUnloading', 'onTime'];
  const numeric = column => `NULLIF(BTRIM(${identifier(column)}), '') ~ '^[0-9]+(?:\\.[0-9]+)?$'`;
  const inFullSql = `CASE WHEN ${numeric('quantity')} AND ${numeric('actual_received')} THEN CASE WHEN ${identifier('actual_received')}::numeric >= ${identifier('quantity')}::numeric THEN 'Yes' ELSE 'No' END ELSE '' END`;
  const inFullPercentSql = `CASE WHEN ${numeric('quantity')} AND ${numeric('actual_received')} AND ${identifier('quantity')}::numeric > 0 THEN ROUND(LEAST(100, ${identifier('actual_received')}::numeric / ${identifier('quantity')}::numeric * 100), 2)::text ELSE '' END`;
  const otifSql = `CASE WHEN ${identifier('on_time')} IN ('Yes','No') AND ${numeric('quantity')} AND ${numeric('actual_received')} THEN CASE WHEN ${identifier('on_time')}='Yes' AND ${identifier('actual_received')}::numeric >= ${identifier('quantity')}::numeric THEN 'Yes' ELSE 'No' END ELSE '' END`;
  const otifPercentSql = `CASE WHEN ${identifier('on_time')}='No' THEN '0' WHEN ${identifier('on_time')}='Yes' AND ${numeric('quantity')} AND ${numeric('actual_received')} AND ${identifier('quantity')}::numeric > 0 THEN ROUND(LEAST(100, ${identifier('actual_received')}::numeric / ${identifier('quantity')}::numeric * 100), 2)::text ELSE '' END`;

  const initialize = async () => {
    if (!pool) fail('SAP database is not configured', 503);
    if (ready) return;
    if (process.env.SAP_AUTO_MIGRATE === 'false') {
      const result = await pool.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', [schemaName, tableName]);
      const actual = new Set(result.rows.map(row => row.column_name));
      const required = ['id', 'record_key', 'shipment_id', 'supplier', 'revision', 'verified', 'updated_at', 'cell_formats', 'row_height', 'row_hidden', ...sapColumns.map(([, , , db]) => db)];
      const missing = required.filter(column => !actual.has(column));
      if (missing.length) fail(`Receiving Records table ${schemaName}.${tableName} needs database migration: ${missing.join(', ')}`, 503);
      ready = true;
      return;
    }
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${identifier(schemaName)}`);
    if (area !== 'SAVOURY' && tableName === 'SAPAnalysisDressings') {
      const tables = await pool.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name=ANY($2::text[])',
        [schemaName, ['SAPAnalysis', 'SAPAnalysisDressings']],
      );
      const existing = new Set(tables.rows.map(row => row.table_name));
      if (!existing.has('SAPAnalysisDressings') && existing.has('SAPAnalysis')) {
        await pool.query(`ALTER TABLE ${identifier(schemaName)}.${identifier('SAPAnalysis')} RENAME TO ${identifier('SAPAnalysisDressings')}`);
        console.log('[SAP] Renamed Analysis.SAPAnalysis to Analysis.SAPAnalysisDressings.');
      }
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
      id BIGSERIAL PRIMARY KEY,
      record_key TEXT UNIQUE NOT NULL,
      shipment_id BIGINT,
      supplier TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE ${table}
      ${sapColumns.map(([, , , db]) => `ADD COLUMN IF NOT EXISTS ${identifier(db)} TEXT NOT NULL DEFAULT ''`).join(',\n')},
      ADD COLUMN IF NOT EXISTS cell_formats JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS row_height INTEGER,
      ADD COLUMN IF NOT EXISTS row_hidden BOOLEAN NOT NULL DEFAULT FALSE`);
    ready = true;
  };

  const decode = row => ({
    key: row.record_key,
    shipmentId: row.shipment_id == null ? '' : String(row.shipment_id),
    supplier: row.supplier || '',
    revision: Number(row.revision || 0),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || ''),
    verified: Boolean(row.verified),
    values: Object.fromEntries(sapColumns.map(([key, , , db]) => [key, key === 'supplierName' ? (row[db] || row.supplier || '') : (row[db] ?? '')])),
    formats: cleanFormats(row.cell_formats),
    rowHeight: row.row_height == null ? null : Number(row.row_height),
    rowHidden: Boolean(row.row_hidden),
  });

  return {
    jsonTrial,
    async sync(rows) {
      await initialize();
      const fingerprints = new Map(rows.map(row => [row.key, JSON.stringify(systemSyncFields.map(key => row.values[key] ?? ''))]));
      const records = rows.filter(row => synced.get(row.key) !== fingerprints.get(row.key)).map(row => ({
        record_key: row.key,
        shipment_id: row.shipmentId || null,
        supplier: row.supplier,
        ...Object.fromEntries(sapColumns.map(([key, , , db]) => [db, String(row.values[key] ?? '')])),
      }));
      if (!records.length) return;
      await pool.query(`INSERT INTO ${table} (record_key, shipment_id, supplier, ${sapColumns.map(([, , , db]) => identifier(db)).join(',')})
        SELECT record_key, shipment_id, supplier, ${sapColumns.map(([, , , db]) => identifier(db)).join(',')}
        FROM jsonb_to_recordset($1::jsonb) AS x(record_key TEXT, shipment_id BIGINT, supplier TEXT, ${sapColumns.map(([, , , db]) => `${identifier(db)} TEXT`).join(',')})
        ON CONFLICT (record_key) DO UPDATE SET
          shipment_id=EXCLUDED.shipment_id,
          supplier=EXCLUDED.supplier,
          ${systemSyncFields.map(key => { const db = sapColumns.find(column => column[0] === key)[3]; return `${identifier(db)}=EXCLUDED.${identifier(db)}`; }).join(',\n')}`, [JSON.stringify(records)]);
      await pool.query(`UPDATE ${table} SET ${identifier('in_full')}=${inFullSql}, ${identifier('in_full_percent')}=${inFullPercentSql}, ${identifier('otif')}=${otifSql}, ${identifier('otif_percent')}=${otifPercentSql} WHERE record_key=ANY($1::text[])`, [records.map(row => row.record_key)]);
      records.forEach(row => synced.set(row.record_key, fingerprints.get(row.record_key)));
    },
    async page(offset, limit, search = '', sort = 'desc') {
      await initialize();
      const term = String(search || '').trim().slice(0, 200);
      const args = [limit + 1, offset];
      let where = '';
      if (term) {
        args.push(`%${term}%`);
        const searchable = ['record_key', 'supplier', ...sapColumns.map(([, , , db]) => db)];
        where = `WHERE concat_ws(' ', ${searchable.map(identifier).join(',')}) ILIKE $3`;
      }
      const direction = String(sort).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const result = await pool.query(`SELECT * FROM ${table} ${where} ORDER BY id ${direction} LIMIT $1 OFFSET $2`, args);
      return { rows: result.rows.slice(0, limit).map(decode), hasMore: result.rows.length > limit };
    },
    async byKeys(keys) {
      await initialize();
      return (await pool.query(`SELECT * FROM ${table} WHERE record_key=ANY($1::text[])`, [keys])).rows.map(decode);
    },
    async all() {
      await initialize();
      return (await pool.query(`SELECT * FROM ${table} ORDER BY id DESC`)).rows.map(decode);
    },
    async forShipment(id) {
      await initialize();
      return (await pool.query(`SELECT * FROM ${table} WHERE shipment_id=$1 ORDER BY id`, [id])).rows.map(decode);
    },
    async forClearance(shipment) {
      await initialize();
      const materialCodes = [...new Set((shipment.items || []).map(item => String(item.materialCode || '').trim()).filter(Boolean))];
      const drNumbers = [...new Set([shipment.drNumber, ...(shipment.items || []).map(item => item.dnNumber)].flatMap(value => String(value || '').split(',')).map(value => value.trim()).filter(Boolean))];
      const poNumbers = [...new Set([shipment.poNumber, ...(shipment.items || []).map(item => item.poNumber)].flatMap(value => String(value || '').split(',')).map(value => value.trim()).filter(Boolean))];
      const result = await pool.query(`SELECT * FROM ${table}
        WHERE shipment_id=$1
          OR (${identifier('item')} <> '' AND ${identifier('item')}=ANY($2::text[]))
          OR (${identifier('dr_number')} <> '' AND ${identifier('dr_number')}=ANY($3::text[]))
          OR (${identifier('po_number')} <> '' AND ${identifier('po_number')}=ANY($4::text[]))
        ORDER BY CASE WHEN shipment_id=$1 THEN 0 ELSE 1 END, id DESC LIMIT 250`, [shipment.id, materialCodes, drNumbers, poNumbers]);
      return result.rows.map(decode);
    },
    async add(values, name) {
      await initialize();
      const key = `manual:${randomUUID()}`;
      const record = Object.fromEntries(sapColumns.map(([field, , , db]) => [db, String(field === 'encodedBy' ? encodedByName(name) : values?.[field] ?? '')]));
      const result = await pool.query(`INSERT INTO ${table} (record_key, supplier, ${sapColumns.map(([, , , db]) => identifier(db)).join(',')})
        VALUES ($1, $2, ${sapColumns.map((_, index) => `$${index + 3}`).join(',')}) RETURNING *`,
      [key, record.supplier_name || '', ...sapColumns.map(([, , , db]) => record[db])]);
      return decode(result.rows[0]);
    },
    async save(rows, name, role) {
      await initialize();
      const allowed = new Set(sapEditableColumns(role));
      const formatAllowed = sapCanFormat(role);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          const assignments = [];
          const args = [];
          for (const [key, , , db] of sapColumns) {
            if (!allowed.has(key) || !Object.prototype.hasOwnProperty.call(row.values || {}, key)) continue;
            args.push(String(row.values[key] ?? ''));
            assignments.push(`${identifier(db)}=$${args.length}`);
          }
          const encodedBySupplied = allowed.has('encodedBy') && Object.prototype.hasOwnProperty.call(row.values || {}, 'encodedBy');
          if (['sap', 'admin', 'plc', 'warehouse'].includes(role) && assignments.length && !encodedBySupplied) {
            args.push(encodedByName(name));
            assignments.push(`${identifier('encoded_by')}=$${args.length}`);
          }
          if (formatAllowed && row.formats) {
            args.push(JSON.stringify(cleanFormats(row.formats)));
            assignments.push(`cell_formats=$${args.length}::jsonb`);
          }
          if (formatAllowed && row.rowHeight !== undefined) {
            args.push(row.rowHeight == null ? null : Math.max(20, Math.min(160, Math.round(Number(row.rowHeight)))));
            assignments.push(`row_height=$${args.length}`);
          }
          if (formatAllowed && row.rowHidden !== undefined) {
            args.push(Boolean(row.rowHidden));
            assignments.push(`row_hidden=$${args.length}`);
          }
          if (!assignments.length) fail('No permitted worksheet changes were supplied', 403);
          if (['sap', 'admin', 'plc', 'warehouse'].includes(role)) {
            args.push(Boolean(row.verified));
            assignments.push(`verified=$${args.length}`);
          }
          args.push(row.key);
          const keyParameter = args.length;
          args.push(Number(row.revision));
          const revisionParameter = args.length;
          const result = await client.query(`UPDATE ${table} SET ${assignments.join(',')}, revision=revision+1, updated_at=NOW()
            WHERE record_key=$${keyParameter} AND revision=$${revisionParameter} RETURNING record_key`, args);
          if (!result.rowCount) fail('Worksheet changed. Reload before saving.', 409);
          await client.query(`UPDATE ${table} SET ${identifier('in_full')}=${inFullSql}, ${identifier('in_full_percent')}=${inFullPercentSql}, ${identifier('otif')}=${otifSql}, ${identifier('otif_percent')}=${otifPercentSql} WHERE record_key=$1`, [row.key]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
