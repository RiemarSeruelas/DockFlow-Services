import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import { createHmac } from 'node:crypto';
import {createFixture,KEY} from './helpers/fixture.js';
import {loadConfig} from '../src/config.js';
import {createLogger,safeText,withLogContext} from '../src/utils/logger.js';
let fixture;
before(async()=>{fixture=await createFixture();});after(async()=>{await fixture?.close();});
test('Startup validates key length, database credentials and identifiers',()=>{
 assert.throws(()=>loadConfig({API_KEYS:'short'}),/Invalid configuration/);
 assert.throws(()=>loadConfig({API_KEYS:KEY,PGHOST:'fixture',PGUSER:'fixture',PGPASSWORD:'fixture',DOCKFLOW_SCHEMA:'Analysis;drop table'}),/PostgreSQL identifier/);
 const config=loadConfig({COMPANY_API_KEY:KEY,COMPANY_DB_HOST:'fixture',DOCKFLOW_COMPANY_DB_USER:'dock',DOCKFLOW_COMPANY_DB_PASSWORD:'dock-pass',POWER_TOOL_COMPANY_DB_USER:'power',POWER_TOOL_COMPANY_DB_PASSWORD:'power-pass'});
 assert.equal(config.port,5230);assert.equal(config.dockflow.connection.user,'dock');assert.equal(config.powerTool.connection.user,'power');
});
test('Protected operations reject missing, bad and conflicting tokens before any database work',async()=>{
 const count=fixture.pools.dockflow.calls.length+fixture.pools.powerTool.calls.length;
 for(const key of ['', 'wrong-key'])assert.equal((await fixture.call('/api/v1/dockflow/health',undefined,{key})).status,401);
 assert.equal((await fixture.call('/api/v1/dockflow/health',undefined,{headers:{'X-API-Key':'other'}})).status,401);
 assert.equal((await fixture.call('/api/v1/power-tool/read',undefined,{key:'',headers:{Authorization:'Malformed token'}})).status,401);
 assert.equal(fixture.pools.dockflow.calls.length+fixture.pools.powerTool.calls.length,count);
});
test('Bearer and X-API-Key authorize the nonce/HMAC handshake for both callers',async()=>{
 const nonce='01'.repeat(32);
 for(const caller of ['dockflow','power-tool']){
  const result=await fixture.call('/api/v1/handshake',{nonce,caller},{key:'',headers:{'X-API-Key':KEY,'X-Request-ID':'handshake-'+caller}});
  assert.equal(result.status,200);assert.equal(result.body.nonce,nonce);assert.equal(result.body.protocolVersion,1);
  assert.deepEqual(result.body.applications,['dockflow','power-tool']);
  assert.equal(result.body.proof,createHmac('sha256',KEY).update(`dockflow-services:1:${nonce}:dockflow,power-tool:13.3.0`).digest('hex'));
  assert.equal(result.body.requestId,'handshake-'+caller);
 }
 assert.equal((await fixture.call('/api/v1/handshake',{nonce:'abc',caller:'dockflow'})).status,400);
 assert.equal((await fixture.call('/api/v1/handshake',{nonce,caller:'unrecognized'})).status,400);
});
test('Public liveness and readiness check the one process and both repositories',async()=>{
 const health=await fixture.call('/health',undefined,{key:''});assert.equal(health.status,200);assert.equal(health.body.version,'13.3.0');
 const ready=await fixture.call('/ready',undefined,{key:''});assert.equal(ready.status,200);assert.equal(ready.body.status,'ready');
 assert.equal((await fixture.call('/api/v1/dockflow/health')).body.areas.SAVOURY.worksheetVersion,'13.2');
 assert.equal((await fixture.call('/api/v1/power-tool/health')).body.approvalSafetyVersion,'13.2');
});
test('Invalid JSON, operation names and unsafe snapshots return 400 without changing data',async()=>{
 assert.equal((await fixture.call('/api/v1/handshake',undefined,{raw:'{bad json'})).status,400);
 assert.equal((await fixture.call('/api/v1/dockflow/sap/OTHER/page',{args:[]})).status,400);
 assert.equal((await fixture.call('/api/v1/dockflow/sap/DRESSINGS/sql',{args:['DELETE FROM anything']})).status,400);
 assert.equal((await fixture.call('/api/v1/power-tool/write',{before:{},after:{}})).status,400);
 const before=(await fixture.call('/api/v1/power-tool/read',{})).body.result,after=structuredClone(before);after.requests.push({...after.requests[0]});
 assert.equal((await fixture.call('/api/v1/power-tool/write',{before,after})).status,400);
 assert.equal((await fixture.call('/api/v1/power-tool/read',{})).body.result.requests.length,before.requests.length);
 assert.equal((await fixture.call('/api/integrations/company-bridge/next',{workerId:'obsolete'})).status,404);
});
test('Request IDs reach the HTTP response and every database query log, without values or tokens',async()=>{
 const requestId='fixture-correlated-request',start=fixture.entries.length;
 const result=await fixture.call('/api/v1/dockflow/sap/DRESSINGS/page',{args:[0,25,'Private fixture description',{}]},{headers:{'X-Request-ID':requestId}});
 assert.equal(result.status,200);assert.equal(result.headers.get('x-request-id'),requestId);
 const logs=fixture.entries.slice(start),queries=logs.filter(entry=>entry.event.startsWith('request.database.'));
 assert.ok(queries.length>=2);assert.ok(queries.every(entry=>entry.requestId===requestId));
 assert.ok(logs.some(entry=>entry.event==='request.completed'&&entry.status===200));
 assert.ok(logs.every(entry=>['INITIALIZATION','USER_REQUEST','CONNECTION'].includes(entry.category)));
 assert.ok(!JSON.stringify(logs).includes(KEY));assert.ok(!JSON.stringify(logs).includes('Private fixture description'));
});
test('Logging suppresses unrelated events, health request noise and secret values loaded after import',()=>{
 const entries=[],logger=createLogger({writer:entry=>entries.push(entry)});
 process.env.COMPANY_API_KEY='late-loaded-fixture-secret';
 try{
  logger.info('unrelated.event');withLogContext({operation:'health'},()=>logger.info('request.completed'));
  withLogContext({requestId:'safe'},()=>logger.error('request.failed',{body:{password:'private'},failure:new Error('late-loaded-fixture-secret Bearer abcdef')}));
  assert.equal(entries.length,1);assert.ok(!entries[0].includes('late-loaded-fixture-secret'));assert.ok(!entries[0].includes('abcdef'));assert.ok(!entries[0].includes('private'));
  assert.equal(safeText('late-loaded-fixture-secret'),'[REDACTED]');
 }finally{delete process.env.COMPANY_API_KEY;}
});
