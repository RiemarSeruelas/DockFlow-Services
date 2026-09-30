import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { createSapRepository, sapColumns, savouryColumns, switchRuntimeSapHost } from '../server/dockflow/sap-postgres.js';

// Run production repository SQL on PostgreSQL, with the two supplied CSV schemas.
const database = new PGlite();
const queries = [];
const originalPool = Object.getOwnPropertyDescriptor(pg, 'Pool');
class TestPool {
  on() { return this; }
  async query(sql, args) {
    queries.push(sql);
    const result = await database.query(sql, args);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  }
  async connect() { return { query: this.query.bind(this), release() {} }; }
  async end() {}
}

before(async () => {
  process.env.POSTGRES_PASSWORD = 'test-only';
  process.env.POSTGRES_SCHEMA = 'Analysis';
  process.env.POSTGRES_HOST = '10.0.0.1';
  process.env.POSTGRES_DB = 'test';
  process.env.POSTGRES_USER = 'test';
  Object.defineProperty(pg, 'Pool', { value: TestPool, writable: true, configurable: true });
  await switchRuntimeSapHost('10.0.0.1');
  await database.exec('CREATE SCHEMA "Analysis";');
  await database.exec(`CREATE TABLE "Analysis"."SAPAnalysisDressings" (
    id BIGSERIAL PRIMARY KEY, record_key TEXT UNIQUE NOT NULL, shipment_id BIGINT, supplier TEXT,
    revision INTEGER DEFAULT 0, verified BOOLEAN DEFAULT false, updated_at TIMESTAMPTZ DEFAULT now(),
    cell_formats JSONB DEFAULT '{}', row_height INTEGER, row_hidden BOOLEAN DEFAULT false,
    ${sapColumns.map(([, , , db]) => `"${db}" TEXT DEFAULT ''`).join(', ')}
  );`);
  const nativeTypes = { source_row: 'INTEGER', section_index: 'INTEGER', total_weight: 'NUMERIC', scheduled_qty: 'NUMERIC', actual_qty: 'NUMERIC', date: 'TIMESTAMP', scheduled_date: 'TIMESTAMP', expiration_date: 'TIMESTAMP' };
  await database.exec(`CREATE TABLE "Analysis"."SAPAnalysisSavoury" (
    id BIGSERIAL PRIMARY KEY, record_key TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
    ${savouryColumns.map(([, , , db]) => `"${db}" ${nativeTypes[db] || 'TEXT'}`).join(', ')}
  );`);
  await database.query(`INSERT INTO "Analysis"."SAPAnalysisDressings" (record_key, shipment_id, supplier, item, description, quantity, dr_number) VALUES ('historical:one', 9007199254740993, 'Fixture supplier', '64005553', 'CITRIC ACID', '500', 'DR-100');`);
  await database.query(`INSERT INTO "Analysis"."SAPAnalysisSavoury" (record_key, source_sheet, item_code, description, actual_qty, supplier, dr_number)
    SELECT 'source:' || value, CASE WHEN value % 2 = 0 THEN 'PM SDS' ELSE 'RM SDS' END, '64204756', 'EGG POWDER', 20, 'Fixture supplier', 'DR-' || value FROM generate_series(1, 30991) AS value;`);
});
after(async () => { Object.defineProperty(pg, 'Pool', originalPool); await database.close(); });

test('Dressings reads the supplied table without requesting the absent extension fields', async () => {
  const repository = createSapRepository('DRESSINGS');
  const page = await repository.page(0, 25);
  assert.equal(page.rows[0].values.description, 'CITRIC ACID');
  assert.equal(page.rows[0].shipmentId, '9007199254740993');
  assert.equal(page.source.serviceVersion, '11.1.0');
  assert.equal(page.canFormat, true);
  assert.deepEqual(page.source.missingOptionalColumns, []);
  assert.equal(queries.some(sql => /\b(issued|rt_reasoning|week_number|pallet_type|foil_weight|pallet_weight_kg|in_full_percent|otif_percent)\b/.test(sql)), false);
});

test('Savoury fetches 30,991 source rows in pages using its own field names', async () => {
  const repository = createSapRepository('SAVOURY');
  const first = await repository.page(0, 25, '', 'asc');
  assert.equal(first.rows.length, 25);
  assert.equal(first.rows[0].values.itemCode, '64204756');
  assert.equal(first.rows[0].values.description, 'EGG POWDER');
  assert.equal(first.canFormat, false);
  assert.equal(first.hasMore, true);
  assert.ok(first.rows[0].revision > 0);
  const last = await repository.page(30975, 25, '', 'asc');
  assert.equal(last.rows.length, 16);
  assert.equal(last.hasMore, false);
  const matching = await repository.page(0, 25, 'PM SDS', 'asc');
  assert.equal(matching.rows.length, 25);
  assert.ok(matching.rows.every(row => row.values.sourceSheet === 'PM SDS'));
  await repository.sync([{ key: 'booking:must-not-be-imported', values: {} }]);
  assert.equal((await database.query('SELECT COUNT(*)::integer AS total FROM "Analysis"."SAPAnalysisSavoury"')).rows[0].total, 30991);
});

test('Savoury edits native numeric and timestamp columns and rejects stale revisions', async () => {
  const repository = createSapRepository('SAVOURY');
  const [row] = (await repository.page(0, 1, '', 'asc')).rows;
  const [saved] = await repository.save([{ ...row, values: { actualQty: '12.5', scheduledDate: '' } }], 'Fixture analyst', 'warehouse');
  assert.ok(saved.revision > row.revision);
  const [fresh] = await repository.byKeys([row.key]);
  assert.equal(fresh.values.actualQty, '12.5');
  assert.equal(fresh.values.scheduledDate, '');
  await assert.rejects(repository.save([{ ...row, values: { actualQty: '99' } }], 'Fixture analyst', 'warehouse'), error => error.status === 409);
  assert.equal((await repository.byKeys([row.key]))[0].values.actualQty, '12.5');
});

test('Optional Dressings fields are omitted from reads, searches, synchronization and edits', async () => {
  await database.exec('ALTER TABLE "Analysis"."SAPAnalysisDressings" DROP COLUMN qa_start, DROP COLUMN qa_end, DROP COLUMN cell_formats, DROP COLUMN row_height, DROP COLUMN row_hidden;');
  const repository = createSapRepository('DRESSINGS');
  const page = await repository.page(0, 25, 'CITRIC');
  assert.equal(page.rows.length, 1);
  assert.equal(page.canFormat, false);
  assert.ok(!page.columns.some(column => column[3] === 'qa_start'));
  await repository.sync([{ key: 'booking:1', shipmentId: '42', supplier: 'Fixture supplier', values: { deliveryDate: '2026-09-30', item: 'TEST-1', quantity: '100', supplierName: 'Fixture supplier', onTime: 'Yes' } }]);
  const [row] = await repository.byKeys(['booking:1']);
  const [saved] = await repository.save([{ ...row, values: { actualReceived: '75', remarks: 'Partial' } }], 'Fixture analyst', 'warehouse');
  assert.equal(saved.revision, row.revision + 1);
  const [fresh] = await repository.byKeys([row.key]);
  assert.equal(fresh.values.actualReceived, '75');
  assert.equal(fresh.values.inFull, 'No');
  assert.equal(fresh.values.otif, 'No');
  assert.equal(fresh.values.remarks, 'Partial');
  await assert.rejects(repository.save([{ ...row, values: { remarks: 'Stale' } }], 'Fixture analyst', 'warehouse'), error => error.status === 409);
  assert.ok((await repository.forClearance({ id: 42, items: [{ materialCode: 'TEST-1' }] })).some(item => item.key === row.key));
});

test('Missing Power Tool logs do not prevent reading existing application data', async () => {
  process.env.POSTGRES_ENABLED = 'true';
  process.env.POSTGRES_ONLY = 'true';
  process.env.POSTGRES_SCHEMA = 'power_tool';
  process.env.POWER_TOOL_AUTO_MIGRATE = 'false';
  process.env.ADMIN_PASSWORD = 'Test-only-admin-password!123';
  process.env.INITIAL_REVIEWER_PASSWORD = 'Test-only-reviewer-password!123';
  await database.exec('CREATE SCHEMA power_tool; CREATE TABLE power_tool.power_tool_meta (singleton BOOLEAN PRIMARY KEY, record JSONB); CREATE TABLE power_tool.power_tool_usage (singleton BOOLEAN PRIMARY KEY, record JSONB);');
  const jsonStore = await import('../server/power-tool/jsonDataStore.js');
  const fixture = jsonStore.normalizeDb({ ...jsonStore.createInitialDb(), items: [{ id: 1, name: 'Existing tool' }] }).db;
  await database.query('INSERT INTO power_tool.power_tool_meta VALUES (true, $1::jsonb)', [JSON.stringify(fixture.meta)]);
  await database.query('INSERT INTO power_tool.power_tool_usage VALUES (true, $1::jsonb)', [JSON.stringify(fixture.usage)]);
  for (const table of ['categories', 'legacy_categories', 'staff_accounts', 'requests', 'items']) await database.exec(`CREATE TABLE power_tool.power_tool_${table} (id TEXT PRIMARY KEY, record JSONB);`);
  for (const [key, table] of Object.entries({ categories: 'categories', legacyCategories: 'legacy_categories', staffAccounts: 'staff_accounts', requests: 'requests', items: 'items' })) for (const row of fixture[key]) await database.query(`INSERT INTO power_tool.power_tool_${table} VALUES ($1, $2::jsonb)`, [row.id, JSON.stringify(row)]);
  const store = await import('../server/power-tool/dataStore.js');
  await store.initializeDataStore();
  await store.reconnectPostgres();
  const health = await store.checkDb();
  assert.equal(health.ok, true);
  assert.equal(health.loggingAvailable, false);
  const data = await store.readDb();
  assert.equal(data.items[0].name, 'Existing tool');
  assert.equal((await store.recordPowerToolLog({ eventType: 'visit' })).stored, false);
  await store.closeDb();
});
