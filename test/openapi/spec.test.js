import assert from 'node:assert/strict';
import {test} from 'node:test';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv from 'ajv';
import {loadSpec} from '../../src/openapi/spec.js';
import {createFixture,KEY} from '../helpers/fixture.js';
test('OpenAPI validates, documents both modules and serves local Swagger assets',async()=>{
 const {document}=loadSpec();await SwaggerParser.validate(structuredClone(document));
 assert.equal(document.info.version,'13.3.0');assert.ok(document.paths['/api/v1/handshake']);assert.ok(document.paths['/api/v1/power-tool/write']);
 const fixture=await createFixture();
 try{
  assert.deepEqual((await fixture.call('/openapi.json',undefined,{key:''})).body,document);
  const contract=await SwaggerParser.dereference(structuredClone(document)),ajv=new Ajv({strict:false});
  for(const [path,method,body,options] of [
   ['/health','get',undefined,{key:''}],['/ready','get',undefined,{key:''}],
   ['/api/v1/handshake','post',{nonce:'01'.repeat(32),caller:'dockflow'}],
   ['/api/v1/dockflow/health','get'],['/api/v1/power-tool/health','get'],
   ['/api/v1/power-tool/read','post',{}],
   ['/api/v1/dockflow/sap/DRESSINGS/page','post',{args:[0,25,'',{}]}],
  ]) {
   const response=await fixture.call(path,body,options);
   const specPath=path.includes('/sap/')?'/api/v1/dockflow/sap/{area}/{operation}':path;
   const schema=contract.paths[specPath][method].responses['200'].content['application/json'].schema;
   const validate=ajv.compile(schema);assert.equal(response.status,200);assert.ok(validate(response.body),JSON.stringify(validate.errors));
  }
  const denied=await fixture.call('/api/v1/dockflow/health',undefined,{key:''}),errorSchema=contract.paths['/api/v1/dockflow/health'].get.responses['401'].content['application/json'].schema;
  assert.equal(denied.status,401);assert.ok(ajv.compile(errorSchema)(denied.body));
  const response=await fetch(fixture.url+'/docs/');assert.equal(response.status,200);assert.match(await response.text(),/DockFlow &amp; Power Tool|DockFlow & Power Tool/);
  assert.match(response.headers.get('content-security-policy'),/connect-src 'self'/);
  const asset=await fetch(fixture.url+'/docs/swagger-ui-bundle.js');assert.equal(asset.status,200);
 }finally{await fixture.close();}
});
