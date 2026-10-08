import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { SERVICE_VERSION } from '../server/logger.js';
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
    ${savouryColumns.filter(([key])=>!['poNumber','batch','supplierLot','mfgDate','breakdown','palletType','foilWeight','palletWeightKg'].includes(key)).map(([, , , db]) => `"${db}" ${nativeTypes[db] || 'TEXT'}`).join(', ')}
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
  assert.equal(page.source.serviceVersion, SERVICE_VERSION);
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

test('13.1 filters, ordering, copied Savoury rows and all SAP column permissions run on the existing PostgreSQL schema', async () => {
  const repository = createSapRepository('SAVOURY');
  const page = await repository.page(0, 25, '', {direction:'asc',filters:{drNumber:'DR-123'},exclude:[]});
  assert.equal(page.source.worksheetVersion,'13.2');
  assert.ok(page.rows.every(row=>row.values.drNumber.includes('DR-123')));
  const [first] = (await repository.page(0,1,'',{direction:'asc'})).rows;
  const [saved] = await repository.save([{key:first.key,revision:first.revision,values:{sourceSheet:'SAP ALL EDITABLE',actualQty:'25',scheduledQty:'1.5'}}], 'Test SAP', 'sap');
  const fresh=(await repository.byKeys([first.key]))[0];
  assert.equal(fresh.values.sourceSheet,'SAP ALL EDITABLE');assert.equal(fresh.values.actualQty,'25');assert.equal(fresh.revision,saved.revision);
  const copied=await repository.add({itemCode:'00001',drNumber:'DR-NEW',scheduledQty:0,scheduledDate:'',actualQty:''},'Test SAP','42:1:line:a');
  assert.match(copied.key,/^42:1:copy:/);assert.equal(copied.values.itemCode,'00001');assert.equal(copied.values.sourceSheet,'DockFlow');assert.equal(copied.values.scheduledQty,'0');
  const ordered=await repository.page(0,1,'',{direction:'desc',order:{[first.key]:100000},exclude:[copied.key]});
  assert.equal(ordered.rows[0].key,first.key);
  const excluded=await repository.page(0,100,'DR-NEW',{direction:'asc',exclude:[copied.key]});assert.equal(excluded.rows.length,0);
  const dressings=createSapRepository('DRESSINGS');const row=(await dressings.page(0,1)).rows[0];
  await dressings.save([{key:row.key,revision:row.revision,values:{deliveryDate:'2026-10-07',inFull:'Manual',otif:'Manual'}}],'Test SAP','sap');
  const edited=(await dressings.byKeys([row.key]))[0];assert.equal(edited.values.deliveryDate,'2026-10-07');assert.equal(edited.values.inFull,'Manual');assert.equal(edited.values.otif,'Manual');
  assert.equal(queries.some(sql=>/CREATE|ALTER|DROP/.test(sql)),false);
});


test('13.1 sorts and filters 30,991 complete rows before pagination and validates fixed column names', async () => {
  await database.query(`UPDATE "Analysis"."SAPAnalysisSavoury" SET batch_no_lot_no=REPLACE(record_key,'source:',''), actual_qty=REPLACE(record_key,'source:','')::numeric, supplier=CASE WHEN id%3=0 THEN 'Sort fixture' ELSE 'Other fixture' END WHERE record_key LIKE 'source:%'`);
  const repository=createSapRepository('SAVOURY');
  const first=await repository.page(0,50,'',{column:'batchNoLotNo',direction:'desc',filters:{supplier:'Sort fixture'}});
  const second=await repository.page(50,50,'',{column:'batchNoLotNo',direction:'desc',filters:{supplier:'Sort fixture'}});
  assert.equal(first.rows[0].values.batchNoLotNo,'30990');
  assert.equal(second.rows[0].values.batchNoLotNo,'30840');
  for(const row of [...first.rows,...second.rows]){
    assert.equal(row.key,'source:'+row.values.batchNoLotNo);
    assert.equal(row.values.actualQty,row.values.batchNoLotNo);
    assert.equal(row.values.supplier,'Sort fixture');
  }
  const numeric=await repository.page(0,3,'',{column:'actualQty',direction:'asc',filters:{supplier:'Sort fixture'}});
  assert.deepEqual(numeric.rows.map(row=>row.values.actualQty),['3','6','9']);
  for(const config of [{column:'batch; DROP TABLE x',direction:'asc'},{column:'actual_qty',direction:'asc'},{column:'actualQty',direction:'asc; SELECT 1'},{filters:[]},{order:{bad:'SQL'}}]) await assert.rejects(repository.page(0,50,'',config),error=>error.status===400);
  const literal=await repository.page(0,50,'',{filters:{drNumber:'% OR 1=1 --'},direction:'asc'});
  assert.equal(literal.rows.length,0);
});

test('13.1 sorts text dates chronologically, handles Manila and ISO timestamps, and leaves invalid dates last', async () => {
  const dates=['10/8/26, 2:00 PM','2026-10-08T08:00:00Z','2026-01-02','2026-99-99','not a date','2026-10-08T15:00:00+08:00'];
  for(let index=0;index<dates.length;index++) await database.query('INSERT INTO "Analysis"."SAPAnalysisDressings" (record_key,description,delivery_date) VALUES ($1,$2,$3)',['date:'+index,'SORT DATE TEST',dates[index]]);
  const repository=createSapRepository('DRESSINGS');
  const first=await repository.page(0,3,'',{column:'deliveryDate',direction:'asc',filters:{description:'SORT DATE TEST'}});
  assert.deepEqual(first.rows.map(row=>row.key),['date:2','date:0','date:5']);
  const tail=await repository.page(3,3,'',{column:'deliveryDate',direction:'asc',filters:{description:'SORT DATE TEST'}});
  assert.deepEqual(tail.rows.map(row=>row.key),['date:1','date:3','date:4']);
  const reverse=await repository.page(0,4,'',{column:'deliveryDate',direction:'desc',filters:{description:'SORT DATE TEST'}});
  assert.deepEqual(reverse.rows.map(row=>row.key),['date:1','date:5','date:0','date:2']);
  await database.query('DELETE FROM "Analysis"."SAPAnalysisDressings" WHERE record_key LIKE $1',['date:%']);
});

test('13.2 sorts and filters supplemental Savoury values over the full legacy table without schema writes', async()=>{
  const repository=createSapRepository('SAVOURY');
  const receivingValues={'source:7':{poNumber:'100',batch:'2',supplierLot:'LOCAL-A',palletType:'Allergen A',foilWeight:'0',palletWeightKg:'2',mfgDate:'2026-02-01'},'source:30991':{poNumber:'200',batch:'10',supplierLot:'LOCAL-B',palletType:'Allergen B',foilWeight:'1.5',palletWeightKg:'10',mfgDate:'2026-01-01'}};
  const first=await repository.page(0,1,'',{column:'batch',direction:'desc',receivingValues});
  assert.equal(first.rows[0].key,'source:30991');assert.equal(first.hasMore,true);
  const next=await repository.page(1,1,'',{column:'batch',direction:'desc',receivingValues});assert.equal(next.rows[0].key,'source:7');
  const filtered=await repository.page(0,25,'',{filters:{supplierLot:'LOCAL-B'},receivingValues});assert.deepEqual(filtered.rows.map(row=>row.key),['source:30991']);
  const search=await repository.page(0,25,'LOCAL-A',{receivingValues});assert.deepEqual(search.rows.map(row=>row.key),['source:7']);
  const dates=await repository.page(0,2,'',{column:'mfgDate',direction:'asc',receivingValues});assert.deepEqual(dates.rows.map(row=>row.key),['source:30991','source:7']);
  const weights=await repository.page(0,2,'',{column:'palletWeightKg',direction:'desc',filters:{palletWeightKg:'10'},receivingValues});assert.deepEqual(weights.rows.map(row=>row.key),['source:30991']);
  const foil=await repository.page(0,2,'',{column:'foilWeight',direction:'asc',filters:{palletType:'Allergen'},receivingValues});assert.deepEqual(foil.rows.map(row=>row.key),['source:7','source:30991']);
  assert.ok(!first.columns.some(([key])=>key==='supplierLot')); // absent company values remain absent, not fabricated
  assert.equal(queries.some(sql=>/CREATE|ALTER|DROP/.test(sql)),false);
  await assert.rejects(repository.page(0,25,'',{receivingValues:{bad:{itemCode:'x'}}}),error=>error.status===400);
});

test('13.2 clearance fetches every matching DR/PO line, including more than ten thousand rows',async()=>{
  const repository=createSapRepository('SAVOURY');
  const shipment={id:999,items:[{materialCode:'64204756',dnNumber:'DR-6 / DR-9',poNumber:'PO-1'}]};
  const rows=await repository.forClearance(shipment);assert.deepEqual(new Set(rows.map(row=>row.key)),new Set(['source:6','source:9']));
  await database.query(`UPDATE "Analysis"."SAPAnalysisSavoury" SET dr_number='CLEARANCE-BULK' WHERE record_key LIKE 'source:%'`);
  const many=await repository.forClearance({id:999,items:[{materialCode:'64204756',dnNumber:'CLEARANCE-BULK'}]});assert.equal(many.length,30991);
  assert.equal((await repository.forClearance({id:999,items:[{materialCode:'different',dnNumber:'CLEARANCE-BULK'}]})).length,0);
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
  await database.exec('CREATE SCHEMA power_tool; CREATE TABLE power_tool.power_tool_meta (singleton BOOLEAN PRIMARY KEY, record JSONB, updated_at TIMESTAMPTZ DEFAULT now()); CREATE TABLE power_tool.power_tool_usage (singleton BOOLEAN PRIMARY KEY, record JSONB, updated_at TIMESTAMPTZ DEFAULT now());');
  const jsonStore = await import('../server/power-tool/jsonDataStore.js');
  const fixture = jsonStore.normalizeDb({ ...jsonStore.createInitialDb(), items: [{ id: 1, name: 'Existing tool' }] }).db;
  await database.query('INSERT INTO power_tool.power_tool_meta VALUES (true, $1::jsonb)', [JSON.stringify(fixture.meta)]);
  await database.query('INSERT INTO power_tool.power_tool_usage VALUES (true, $1::jsonb)', [JSON.stringify(fixture.usage)]);
  for (const table of ['categories', 'legacy_categories', 'staff_accounts', 'requests', 'items']) await database.exec(`CREATE TABLE power_tool.power_tool_${table} (id TEXT PRIMARY KEY, record JSONB, updated_at TIMESTAMPTZ DEFAULT now());`);
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
  const pending=await store.readDb();pending.requests.push({id:'test-retry',categoryId:'cat-elc',status:'pending',itemName:'Retry fixture',specificReviewGroupsSnapshot:[],specificCriteriaId:'',specificCriteriaName:''});await store.writeDb(pending);
  const a=await store.readDb(),b=await store.readDb(),staleGet=await store.readDb();
  a.requests.find(row=>row.id==='test-retry').status='approved';a.requests.find(row=>row.id==='test-retry').itemId='asset-first';a.items.push({id:'asset-first',requestId:'test-retry',qrId:'QR-FIRST',expiresAt:'2027-01-01',renewalHistory:[],specificCriteriaId:'',specificCriteriaName:''});await store.writeDb(a);
  b.requests.find(row=>row.id==='test-retry').status='approved';b.items.push({id:'asset-duplicate',requestId:'test-retry',qrId:'QR-DUPLICATE'});
  await assert.rejects(store.writeDb(b),error=>error.code==='APPROVAL_CONFLICT');
  staleGet.requests.find(row=>row.id==='test-retry').currentApprovalRole='reviewer-or-admin';await assert.rejects(store.writeDb(staleGet),error=>error.code==='APPROVAL_CONFLICT');
  const final=await store.readDb();assert.equal(final.requests.find(row=>row.id==='test-retry').status,'approved');assert.equal(final.items.filter(row=>row.requestId==='test-retry').length,1);assert.equal(final.items.find(row=>row.requestId==='test-retry').qrId,'QR-FIRST');
  await store.closeDb();
});
