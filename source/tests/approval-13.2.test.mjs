import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { pathToFileURL } from 'node:url';
const powerToolRoot=resolve(process.env.POWER_TOOL_SOURCE||'../../../work/apps/power-tool');
const { validityDate, expiryDeadline, usableValidityDate, existingValidityDate }=await import(pathToFileURL(join(powerToolRoot,'server/approval-validity.js')));

test('strict calendar validation and Manila end-of-day expiry preserve existing request/category dates',()=>{
 const now=Date.parse('2026-10-08T15:59:59+08:00');
 assert.equal(validityDate('2026-02-31'),'');assert.equal(validityDate('2026-02-31T00:00:00Z'),'');assert.equal(validityDate('2028-02-29'),'2028-02-29');
 assert.equal(expiryDeadline('2026-10-08'),Date.parse('2026-10-08T23:59:59.999+08:00'));assert.equal(usableValidityDate('2026-10-08',now),'2026-10-08');
 assert.equal(existingValidityDate({detailValues:{toDate:'2026-10-09'}},{},null,now),'2026-10-09');
 assert.equal(existingValidityDate({expiresAt:'2020-01-01'},{expiresAt:'2026-10-10'},null,now),'2026-10-10');
 assert.equal(existingValidityDate({detailValues:{inspection:'2026-10-09'}},{detailFields:[{id:'inspection',label:'Inspection date',type:'date',required:true}]},null,now),'');
});

test('final approval validates first, commits expiry/equipment/QR once, and recognizes concurrent retries through company PostgreSQL',async()=>{
 const database=new PGlite(),original=Object.getOwnPropertyDescriptor(pg,'Pool');let queue=Promise.resolve();
 class Pool{
  on(){return this;}async query(sql,args){const result=await database.query(sql,args);return {...result,rowCount:result.rows.length||result.affectedRows||0};}
  async connect(){const previous=queue;let unlock;queue=new Promise(resolve=>{unlock=resolve;});await previous;return {query:this.query.bind(this),release:unlock};}async end(){}
 }
 const temporary=await mkdtemp(join(tmpdir(),'approval132-'));
 process.env.POSTGRES_ENABLED='true';process.env.POSTGRES_ONLY='true';process.env.POSTGRES_HOST='10.0.0.1';process.env.POSTGRES_PASSWORD='fixture-password';process.env.POSTGRES_USER='fixture';process.env.POSTGRES_DB='fixture';process.env.POSTGRES_SCHEMA='power_tool';process.env.POWER_TOOL_AUTO_MIGRATE='false';process.env.POWER_TOOL_DATA_DIR=temporary;process.env.ADMIN_PASSWORD='Fixture-password-123!';process.env.INITIAL_REVIEWER_PASSWORD='Fixture-password-123!';
 Object.defineProperty(pg,'Pool',{value:Pool,configurable:true});
 await database.exec('CREATE SCHEMA power_tool;CREATE TABLE power_tool.power_tool_meta(singleton BOOLEAN PRIMARY KEY,record JSONB,updated_at TIMESTAMPTZ DEFAULT now());CREATE TABLE power_tool.power_tool_usage(singleton BOOLEAN PRIMARY KEY,record JSONB,updated_at TIMESTAMPTZ DEFAULT now());');
 const jsonStore=await import('../server/power-tool/jsonDataStore.js');const fixture=jsonStore.normalizeDb(jsonStore.createInitialDb()).db;
 for(const table of ['categories','legacy_categories','staff_accounts','requests','items'])await database.exec(`CREATE TABLE power_tool.power_tool_${table}(id TEXT PRIMARY KEY,record JSONB,updated_at TIMESTAMPTZ DEFAULT now());`);
 const future=new Date(Date.now()+45*86400000).toISOString().slice(0,10),later=new Date(Date.now()+90*86400000).toISOString().slice(0,10);
 const request=id=>({id,referenceId:'REF-'+id,categoryId:'cat-portable-tool',categoryName:'Portable Tools',itemName:'Test tool',itemCode:'TOOL-'+id,site:'Test site',submittedBy:'Test person',status:'pending',reviewQuestionsSnapshot:[],specificReviewGroupsSnapshot:[],detailValues:{},detailsSnapshot:[],approvals:[],approvalFlow:['reviewer','admin'],currentApprovalRole:'reviewer-or-admin'});
 fixture.requests=[request('missing'),{...request('existing'),expiresAt:future},{...request('automatic'),reviewQuestionsSnapshot:[{id:'safe',label:'Safe?',type:'yesno',required:true,autoDecision:{enabled:true,outcomes:{Yes:'approved',No:'rejected'}}}]},request('double'),{...request('legacy'),approvals:[{role:'reviewer',approvedBy:'Earlier reviewer',approvedAt:'2026-10-01T00:00:00Z'}],currentApprovalRole:'admin'}];
 Object.assign(fixture,jsonStore.normalizeDb(fixture).db);
 await database.query('INSERT INTO power_tool.power_tool_meta VALUES(true,$1)',[JSON.stringify(fixture.meta)]);await database.query('INSERT INTO power_tool.power_tool_usage VALUES(true,$1)',[JSON.stringify(fixture.usage)]);
 for(const [key,table]of Object.entries({categories:'categories',legacyCategories:'legacy_categories',staffAccounts:'staff_accounts',requests:'requests',items:'items'}))for(const row of fixture[key])await database.query(`INSERT INTO power_tool.power_tool_${table}(id,record) VALUES($1,$2)`,[row.id,JSON.stringify(row)]);
 const store=await import('../server/power-tool/dataStore.js');await store.initializeDataStore();await store.reconnectPostgres();
 const bridge=createServer(async(req,res)=>{
  try{
   let result;if(req.url.endsWith('/health')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({ok:true,provider:'postgresql',approvalSafetyVersion:'13.2'}));}
   if(req.url.endsWith('/read'))result=await store.readDb();
   else if(req.url.endsWith('/write')){let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);result=await store.writeRemoteDb(data.after,data.before);}
   else result={stored:false};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result}));
  }catch(error){res.writeHead(error.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message,code:error.code}));}
 });
 await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
 const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const appRoot=powerToolRoot;
 const api=spawn(process.execPath,['server/index.js'],{cwd:appRoot,env:{...process.env,PORT:String(port),COMPANY_API_BASE_URL:`http://127.0.0.1:${bridge.address().port}`,COMPANY_API_KEY:'fixture',COMPANY_API_ALLOW_HTTP:'true',AUDIT_POSTGRES_ENABLED:'false'},stdio:['ignore','pipe','pipe']});let output='';api.stdout.on('data',chunk=>output+=chunk);api.stderr.on('data',chunk=>output+=chunk);
 const url=`http://127.0.0.1:${port}`;
 const call=async(path,body)=>{const response=await fetch(url+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});return {status:response.status,body:await response.json()};};
 try{
  let healthy=false;for(let i=0;i<100;i++){try{healthy=(await call('/api/health')).status===200;if(healthy)break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(healthy,output);
  const actor={role:'reviewer',approvedBy:'Fixture reviewer',reviewAnswers:{}};
  for(const expiresAt of ['', 'invalid','2026-02-31','2020-01-01']){const result=await call('/api/requests/missing/approve',{...actor,expiresAt});assert.equal(result.status,400);const unchanged=await store.readDb();assert.equal(unchanged.requests.find(row=>row.id==='missing').status,'pending');assert.equal(unchanged.requests.find(row=>row.id==='missing').approvals.length,0);assert.equal(unchanged.items.length,0);}
  assert.equal((await call('/api/requests/existing')).body.expiresAt,future);
  const approved=await call('/api/requests/existing/approve',{...actor,expiresAt:later});assert.equal(approved.status,201);assert.equal(approved.body.item.expiresAt,later);assert.equal(approved.body.item.validity.status,'valid');assert.match(approved.body.item.qrImageDataUrl,/^data:image\/svg\+xml/);
  const retry=await call('/api/requests/existing/approve',{...actor,expiresAt:later});assert.equal(retry.status,200);assert.equal(retry.body.item.id,approved.body.item.id);assert.equal(retry.body.request.approvals.length,1);
  const automaticMissing=await call('/api/requests/automatic/review',{...actor,reviewAnswers:{safe:'Yes'},expiresAt:''});assert.equal(automaticMissing.status,400);assert.equal((await store.readDb()).requests.find(row=>row.id==='automatic').status,'pending');
  const auto=await call('/api/requests/automatic/review',{...actor,reviewAnswers:{safe:'Yes'},expiresAt:future});assert.equal(auto.status,201);assert.equal(auto.body.item.expiresAt,future);
  const legacy=await call('/api/requests/legacy/approve',{...actor,role:'admin',expiresAt:future});assert.equal(legacy.status,201);assert.equal(legacy.body.request.approvals.length,2);assert.equal(legacy.body.request.approvals[0].approvedBy,'Earlier reviewer');
  const legacyRetry=await call('/api/requests/legacy/approve',{...actor,role:'admin',expiresAt:future});assert.equal(legacyRetry.body.item.id,legacy.body.item.id);assert.equal(legacyRetry.body.request.approvals.length,2);
  const pair=await Promise.all([call('/api/requests/double/approve',{...actor,expiresAt:future}),call('/api/requests/double/approve',{...actor,expiresAt:future})]);assert.ok(pair.every(result=>[200,201].includes(result.status)),JSON.stringify(pair));assert.equal(pair[0].body.item.id,pair[1].body.item.id);
  const final=await store.readDb();assert.equal(final.items.filter(row=>row.requestId==='double').length,1);assert.equal(final.requests.find(row=>row.id==='double').approvals.length,1);
  const quick=await call('/api/items');assert.equal(quick.status,200);assert.ok(quick.body.some(row=>row.id===approved.body.item.id&&row.expiresAt===later&&row.validity.status==='valid'));
  const qr=await call('/api/items/qr/'+approved.body.item.qrId);assert.equal(qr.status,200);assert.equal(qr.body.expiresAt,later);assert.equal(qr.body.validity.status,'valid');
 }finally{api.kill('SIGTERM');await new Promise(resolve=>api.once('exit',resolve));await new Promise(resolve=>bridge.close(resolve));await store.closeDb();await database.close();Object.defineProperty(pg,'Pool',original);await rm(temporary,{recursive:true,force:true});}
});
