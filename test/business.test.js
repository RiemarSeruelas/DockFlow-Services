import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {createFixture} from './helpers/fixture.js';
let fixture;
before(async()=>{fixture=await createFixture();});after(async()=>{await fixture?.close();});
test('Both Receiving Records areas keep supplementary values out of unused bind positions (42P18 regression)',async()=>{
 for(const area of ['DRESSINGS','SAVOURY'])for(const options of [{},{column:'description',direction:'asc'},{filters:{description:'Private fixture'}},{exclude:['other']},{order:{'line:1':9}}]){
  const result=await fixture.call(`/api/v1/dockflow/sap/${area}/page`,{args:[0,25,'',{...options,receivingValues:{'line:1':{batch:'5',supplierLot:'Lot fixture'}}}]});
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.result.rows.length,1);
  const query=fixture.pools.dockflow.calls.at(-1),positions=new Set([...query.sql.matchAll(/\$(\d+)/g)].map(match=>Number(match[1])));
  assert.equal(positions.size,query.args.length);
 }
 const extra=await fixture.call('/api/v1/dockflow/sap/SAVOURY/page',{args:[0,25,'',{column:'batch',direction:'asc',filters:{supplierLot:'Lot fixture'},receivingValues:{'line:1':{batch:'5',supplierLot:'Lot fixture'}}}]});
 assert.equal(extra.status,200);assert.equal(extra.body.result.rows.length,1);
 assert.equal(fixture.pools.dockflow.calls.at(-1).args.filter(arg=>typeof arg==='string'&&arg.startsWith('{')).length,1);
});
test('Worksheet writes retain permissions and optimistic revisions',async()=>{
 const path='/api/v1/dockflow/sap/DRESSINGS/';
 const original=(await fixture.call(path+'byKeys',{args:[['line:1']]})).body.result[0];
 const denied=await fixture.call(path+'save',{args:[[{...original,values:{item:'Disallowed edit'}}],'fixture reviewer','security']});
 assert.equal(denied.status,403,JSON.stringify(denied.body));
 const saved=await fixture.call(path+'save',{args:[[{...original,values:{...original.values,description:'Approved new description'}}],'fixture admin','admin']});
 assert.equal(saved.status,200,JSON.stringify(saved.body));
 const current=(await fixture.call(path+'byKeys',{args:[['line:1']]})).body.result[0];assert.equal(current.values.description,'Approved new description');assert.equal(current.revision,original.revision+1);
 assert.equal((await fixture.call(path+'save',{args:[[original],'fixture admin','admin']})).status,409);
});
test('Power Tool writes only changed records and rolls back concurrent final approval conflicts',async()=>{
 const path='/api/v1/power-tool/';const before=(await fixture.call(path+'read',{})).body.result;
 const after=structuredClone(before);after.requests.find(row=>row.id==='double').status='approved';
 after.items.push({id:'asset-fixture',requestId:'double',itemName:'Fixture asset'});
 const first=await fixture.call(path+'write',{before,after});assert.equal(first.status,200,JSON.stringify(first.body));
 const concurrent=structuredClone(before);concurrent.requests.find(row=>row.id==='double').status='approved';concurrent.items.push({id:'asset-duplicate',requestId:'double',itemName:'Duplicate asset'});
 const second=await fixture.call(path+'write',{before,after:concurrent});assert.equal(second.status,409,JSON.stringify(second.body));assert.equal(second.body.code,'APPROVAL_CONFLICT');
 const stored=await fixture.databases.powerTool.query("SELECT record FROM power_tool.power_tool_items WHERE record->>'requestId'='double'");assert.equal(stored.rows.length,1);assert.equal(stored.rows[0].record.id,'asset-fixture');
 assert.ok(!fixture.pools.powerTool.calls.some(call=>call.sql.includes('SAPAnalysis')));assert.ok(!fixture.pools.dockflow.calls.some(call=>call.sql.includes('power_tool_')));
});
test('Missing optional business audit table is reported without replacing it with runtime body logs',async()=>{
 const result=await fixture.call('/api/v1/power-tool/log',{entry:{eventType:'qr_open',eventKey:'fixture-session:qr_open:fixture-item'}});
 assert.equal(result.status,200);assert.equal(result.body.result.stored,false);assert.equal(result.body.result.provider,'postgresql');
});
