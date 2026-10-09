import './environment.js';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { sapColumns,savouryColumns } from '../../src/modules/dockflow/dockflow.repository.js';
import { instrumentPool } from '../../src/utils/database-logging.js';
import { createLogger } from '../../src/utils/logger.js';
import { createInitialDb,normalizeDb } from '../../src/modules/power-tool/power-tool.jsonDataStore.js';
export const KEY='fixture-integration-key-32-bytes-0123456789';
export const FUTURE=new Date(Date.now()+45*86400000).toISOString().slice(0,10);
export function fixturePool(database) {
  let tail=Promise.resolve(); const calls=[];
  async function lock(){const previous=tail;let release;tail=new Promise(resolve=>{release=resolve;});await previous;return release;}
  async function query(sql,args){calls.push({sql,args});const result=await database.query(sql,args);return {...result,rowCount:result.affectedRows||result.rows.length};}
  return {calls,on(){return this;},async query(sql,args){const release=await lock();try{return await query(sql,args);}finally{release();}},async connect(){const release=await lock();return {query,release};},async end(){await database.close();}};
}
export async function createFixture({listen=true}={}) {
  process.env.ADMIN_PASSWORD='Fixture-password-123!';process.env.INITIAL_REVIEWER_PASSWORD='Fixture-password-123!';
  const databases={dockflow:new PGlite(),powerTool:new PGlite()};
  const pools=Object.fromEntries(Object.entries(databases).map(([key,db])=>[key,fixturePool(db)]));
  await databases.dockflow.exec('CREATE SCHEMA "Analysis";');
  for(const [table,columns] of [['SAPAnalysisDressings',sapColumns],['SAPAnalysisSavoury',savouryColumns.filter(column=>!['poNumber','batch','supplierLot','mfgDate','breakdown','palletType','foilWeight','palletWeightKg'].includes(column[0]))]]) {
    const names=[...new Set(columns.map(column=>column[3]))];
    await databases.dockflow.exec(`CREATE TABLE "Analysis"."${table}"(id BIGSERIAL PRIMARY KEY,record_key TEXT UNIQUE,revision BIGINT NOT NULL DEFAULT 0,updated_at TIMESTAMPTZ DEFAULT now(),${names.map(name=>'"'+name+'" TEXT').join(',')});`);
    await databases.dockflow.query(`INSERT INTO "Analysis"."${table}"(record_key,description) VALUES ($1,$2)`,['line:1','Private fixture description']);
  }
  const db=databases.powerTool;
  await db.exec('CREATE SCHEMA power_tool;CREATE TABLE power_tool.power_tool_meta(singleton BOOLEAN PRIMARY KEY,record JSONB,updated_at TIMESTAMPTZ DEFAULT now());CREATE TABLE power_tool.power_tool_usage(singleton BOOLEAN PRIMARY KEY,record JSONB,updated_at TIMESTAMPTZ DEFAULT now());');
  for(const table of ['categories','legacy_categories','staff_accounts','requests','items'])await db.exec(`CREATE TABLE power_tool.power_tool_${table}(id TEXT PRIMARY KEY,record JSONB,updated_at TIMESTAMPTZ DEFAULT now());`);
  let state=normalizeDb(createInitialDb()).db;
  const request=id=>({id,referenceId:'REF-'+id,categoryId:'cat-portable-tool',categoryName:'Portable Tools',itemName:'Test tool',itemCode:'TOOL-'+id,site:'Test site',submittedBy:'Test person',status:'pending',reviewQuestionsSnapshot:[],specificReviewGroupsSnapshot:[],detailValues:{},detailsSnapshot:[],approvals:[],approvalFlow:['reviewer','admin'],currentApprovalRole:'reviewer-or-admin'});
  state.requests=[request('missing'),{...request('existing'),expiresAt:FUTURE},{...request('automatic'),reviewQuestionsSnapshot:[{id:'safe',label:'Safe?',type:'yesno',required:true,autoDecision:{enabled:true,outcomes:{Yes:'approved',No:'rejected'}}}]},request('double'),{...request('legacy'),approvals:[{role:'reviewer',approvedBy:'Earlier reviewer',approvedAt:'2026-10-01T00:00:00Z'}],currentApprovalRole:'admin'}];
  state=normalizeDb(state).db;
  for(const key of ['meta','usage'])await db.query(`INSERT INTO power_tool.power_tool_${key}(singleton,record) VALUES(true,$1)`,[JSON.stringify(state[key])]);
  for(const [key,table]of Object.entries({categories:'categories',legacyCategories:'legacy_categories',staffAccounts:'staff_accounts',requests:'requests',items:'items'}))for(const row of state[key])await db.query(`INSERT INTO power_tool.power_tool_${table}(id,record) VALUES($1,$2)`,[row.id,JSON.stringify(row)]);
  const entries=[],logger=createLogger({writer:line=>entries.push(JSON.parse(line))});
  const config=loadConfig({API_KEYS:KEY,PGHOST:'fixture-host',PGUSER:'fixture-account',PGPASSWORD:'fixture-password'});
  for(const [name,pool] of Object.entries(pools))instrumentPool(pool,config[name].logFields,{logger});
  const app=createApp({config,pools,logger});let server;
  if(listen)server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  const url=server?`http://127.0.0.1:${server.address().port}`:undefined;
  async function call(path,data,{key=KEY,headers={},raw}={}){
    const response=await fetch(url+path,{method:data===undefined&&raw===undefined?'GET':'POST',headers:{...(key?{Authorization:'Bearer '+key}:{}),...(data!==undefined||raw!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:raw===undefined?(data===undefined?undefined:JSON.stringify(data)):raw});
    return {status:response.status,headers:response.headers,body:await response.json()};
  }
  return {databases,pools,config,app,server,url,call,entries,state,async close(){if(server?.listening)await new Promise(resolve=>server.close(resolve));await Promise.all(Object.values(pools).map(pool=>pool.end()));}};
}
