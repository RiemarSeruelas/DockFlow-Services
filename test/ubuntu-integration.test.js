import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createFixture,KEY,FUTURE} from './helpers/fixture.js';
const source=process.env.UBUNTU_SOURCE;
const options={skip:!source};let fixture,clients;
before(async()=>{if(!source)return;fixture=await createFixture();clients={};for(const app of ['dockflow','power-tool'])clients[app]=await import(pathToFileURL(join(resolve(source),app,'server/company-api-client.js')));});
after(async()=>{await fixture?.close();});
function configure(url=fixture.url,key=KEY){Object.assign(process.env,{COMPANY_API_BASE_URL:url,COMPANY_API_KEY:key,COMPANY_API_ALLOW_HTTP:'true'});}
test('Both actual Ubuntu clients authenticate and map existing repository calls to the shared v1 API',options,async()=>{
 configure();for(const app of ['dockflow','power-tool']){
  const client=clients[app];assert.equal((await client.companyHandshake({force:true})).protocolVersion,1);
  assert.equal((await client.companyApi(`api/${app}/health`)).ok,true);
 }
 const result=await clients.dockflow.companyApi('api/dockflow/sap/SAVOURY/page',{args:[0,25,'',{}]});assert.equal(result.result.rows.length,1);
 const state=await clients['power-tool'].companyApi('api/power-tool/read',{});assert.equal(state.result.requests.length,5);
});
test('Ubuntu forwards authenticated user metadata and the same request ID to every SQL log',options,async()=>{
 configure();const logging=await import(pathToFileURL(join(resolve(source),'dockflow/server/company-integration-logging.js')));
 const req={id:'ubuntu-user-request',method:'POST',path:'/api/sap/rows',user:{name:'Fixture user',role:'sap'},get(){return undefined;}};
 const res={setHeader(){},once(){}};let pending;
 logging.companyRequestContext('dockflow-backend')(req,res,()=>{pending=clients.dockflow.companyApi('api/dockflow/sap/DRESSINGS/page',{args:[0,25,'',{}]});});
 await pending;
 const traces=fixture.entries.filter(entry=>entry.requestId===req.id);assert.ok(traces.some(entry=>entry.event==='request.database.completed'));assert.ok(traces.some(entry=>entry.declaredActor?.name==='Fixture user'));
});
test('Ubuntu rejects bad keys, retired bridge URLs, remote HTTP and invalid handshake proofs',options,async()=>{
 for(const client of Object.values(clients)){
  configure(fixture.url,'incorrect-token-but-longer-than-32-bytes');await assert.rejects(client.companyHandshake({force:true}),error=>error.code==='COMPANY_API_AUTH'&&error.status===503);
  configure(fixture.url+'/api/integrations/company-bridge');await assert.rejects(client.companyHandshake({force:true}),error=>error.code==='COMPANY_API_CONFIG');
  configure('http://192.168.1.10:5230');await assert.rejects(client.companyHandshake({force:true}),error=>error.code==='COMPANY_API_CONFIG');
 }
 const fake=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,service:'dockflow-services',serviceVersion:'13.3.0',protocolVersion:1,applications:['dockflow','power-tool'],nonce:data.nonce,proof:'00'.repeat(32)}));});
 await new Promise(resolve=>fake.listen(0,'127.0.0.1',resolve));
 try{configure(`http://127.0.0.1:${fake.address().port}`);for(const client of Object.values(clients))await assert.rejects(client.companyHandshake({force:true}),error=>error.code==='COMPANY_API_HANDSHAKE');}finally{await new Promise(resolve=>fake.close(resolve));configure();}
});
test('The Ubuntu standalone deploy preflight verifies the new API before source changes',options,async()=>{
 const path=resolve(source,'../../verify_company_api.mjs'),config={COMPANY_API_BASE_URL:fixture.url,COMPANY_API_KEY:KEY,COMPANY_API_ALLOW_HTTP:'true'};
 const child=spawn(process.execPath,[path,'--config-stdin'],{stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);child.stdin.end(JSON.stringify(config));
 const exit=await new Promise(resolve=>child.once('exit',resolve));assert.equal(exit,0,output);assert.match(output,/handshake.*checks passed/);assert.ok(!output.includes(KEY));
});
test('Actual Ubuntu Power Tool validates expiry and commits approvals/QR exactly once through the shared Express API',options,async()=>{
 configure();const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const temporary=await mkdtemp(join(tmpdir(),'express-approval-'));
 const api=spawn(process.execPath,['server/index.js'],{cwd:join(resolve(source),'power-tool'),env:{...process.env,PORT:String(port),POSTGRES_ENABLED:'true',POSTGRES_ONLY:'true',POWER_TOOL_DATA_DIR:temporary,AUDIT_POSTGRES_ENABLED:'false'},stdio:['ignore','pipe','pipe']});let output='';api.stdout.on('data',chunk=>output+=chunk);api.stderr.on('data',chunk=>output+=chunk);
 const url=`http://127.0.0.1:${port}`;
 const call=async(path,body,requestId)=>{const response=await fetch(url+path,body?{method:'POST',headers:{'Content-Type':'application/json',...(requestId?{'X-Request-ID':requestId}:{})},body:JSON.stringify(body)}:{});return {status:response.status,body:await response.json()};};
 const read=async()=>(await fixture.call('/api/v1/power-tool/read',{})).body.result;
 try{
  let healthy=false;for(let i=0;i<120;i++){try{healthy=(await call('/api/health')).status===200;if(healthy)break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(healthy,output.slice(-3000));
  const health=await call('/api/health');assert.equal(health.body.version,'13.3');assert.equal(health.body.companyApi.transport,'direct-express-api');
  const actor={role:'reviewer',approvedBy:'Fixture reviewer',reviewAnswers:{}};
  for(const expiresAt of ['', 'invalid','2026-02-31','2020-01-01']){const result=await call('/api/requests/missing/approve',{...actor,expiresAt});assert.equal(result.status,400);const unchanged=await read();assert.equal(unchanged.requests.find(row=>row.id==='missing').status,'pending');assert.equal(unchanged.items.length,0);}
  const later=new Date(Date.now()+90*86400000).toISOString().slice(0,10);
  assert.equal((await call('/api/requests/existing')).body.expiresAt,FUTURE);
  const approved=await call('/api/requests/existing/approve',{...actor,expiresAt:later},'approval-through-express');assert.equal(approved.status,201,JSON.stringify(approved.body));assert.equal(approved.body.item.expiresAt,later);assert.equal(approved.body.item.validity.status,'valid');assert.match(approved.body.item.qrImageDataUrl,/^data:image\/svg\+xml/);
  const retry=await call('/api/requests/existing/approve',{...actor,expiresAt:later});assert.equal(retry.status,200);assert.equal(retry.body.item.id,approved.body.item.id);assert.equal(retry.body.request.approvals.length,1);
  assert.equal((await call('/api/requests/automatic/review',{...actor,reviewAnswers:{safe:'Yes'},expiresAt:''})).status,400);
  const automatic=await call('/api/requests/automatic/review',{...actor,reviewAnswers:{safe:'Yes'},expiresAt:FUTURE});assert.equal(automatic.status,201,JSON.stringify(automatic.body));assert.equal(automatic.body.item.expiresAt,FUTURE);
  const legacy=await call('/api/requests/legacy/approve',{...actor,role:'admin',expiresAt:FUTURE});assert.equal(legacy.status,201);assert.equal(legacy.body.request.approvals.length,2);assert.equal(legacy.body.request.approvals[0].approvedBy,'Earlier reviewer');
  const pair=await Promise.all([call('/api/requests/double/approve',{...actor,expiresAt:FUTURE}),call('/api/requests/double/approve',{...actor,expiresAt:FUTURE})]);assert.ok(pair.every(result=>[200,201].includes(result.status)),JSON.stringify(pair));assert.equal(pair[0].body.item.id,pair[1].body.item.id);
  const final=await read();assert.equal(final.items.filter(row=>row.requestId==='double').length,1);assert.equal(final.requests.find(row=>row.id==='double').approvals.length,1);
  assert.ok((await call('/api/items')).body.some(row=>row.id===approved.body.item.id&&row.expiresAt===later&&row.validity.status==='valid'));
  assert.equal((await call('/api/items/qr/'+approved.body.item.qrId)).body.expiresAt,later);
  assert.ok(fixture.entries.some(entry=>entry.requestId==='approval-through-express'&&entry.event==='request.database.completed'));
  for(const line of output.trim().split('\n').filter(Boolean)){const entry=JSON.parse(line);assert.ok(['INITIALIZATION','USER_REQUEST','CONNECTION'].includes(entry.category));}
  assert.ok(!output.includes(KEY));
  await new Promise(resolve=>fixture.server.close(resolve));
  const unavailable=await call('/api/items');assert.equal(unavailable.status,503,JSON.stringify(unavailable.body));assert.equal(unavailable.body.code,'COMPANY_API_UNREACHABLE');
 }finally{api.kill('SIGTERM');await new Promise(resolve=>api.exitCode!==null?resolve():api.once('exit',resolve));await rm(temporary,{recursive:true,force:true});}
});
