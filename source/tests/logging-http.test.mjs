import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';

process.env.POSTGRES_PASSWORD = 'PASSWORD_SENTINEL_DO_NOT_LOG';
process.env.COMPANY_API_KEY = 'COMPANY_KEY_SENTINEL_DO_NOT_LOG_12345';
const { addLogContext, createLogger, operationSummary, safeError, safeUrl, SERVICE_VERSION } = await import('../server/logger.js');
const { body, listen, send } = await import('../server/http.js');
const captured = [];
const original = { log: console.log, error: console.error };
let server, base;

before(async () => {
  console.log = line => { captured.push(JSON.parse(line)); original.log(line); };
  console.error = line => { captured.push(JSON.parse(line)); original.error(line); };
  server = listen(0, async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path.endsWith('/save')) {
      const payload = await body(request);
      addLogContext(operationSummary('save', payload.args));
      await new Promise(resolve => setTimeout(resolve, payload.args[1] === 'Alice' ? 30 : 5));
      return send(response, 200, { ok: true, result: [{ key: 'private-record', values: { description: 'ROW_CONTENT_SENTINEL' } }] });
    }
    if (path.endsWith('/page')) throw Object.assign(new Error('column "issued" does not exist'), { code: '42703' });
    if (path.endsWith('/describe')) throw Object.assign(new Error('invalid input syntax: "PRIVATE_INPUT_SENTINEL" password=PASSWORD_SENTINEL_DO_NOT_LOG'), { code: '22P02', detail: 'PRIVATE_DETAIL_SENTINEL' });
    if (path.endsWith('/write')) { await body(request); return send(response, 200, { ok: true }); }
    throw Object.assign(new Error('Synchronous handler failure'), { status: 409 });
  }, { host: '127.0.0.1' });
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  console.log = original.log;
  console.error = original.error;
});

test('Concurrent requests retain separate caller, actor and bridge job IDs through completion', async () => {
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const actors = ['Alice', 'Bob'];
  const replies = await Promise.all(ids.map((id, index) => fetch(base + '/api/dockflow/sap/DRESSINGS/save?token=QUERY_SENTINEL', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-ID': id, 'X-Bridge-Job-ID': id,
      'X-Bridge-Worker-ID': 'worker-' + index, 'X-Caller-Service': 'company-worker', Authorization: 'Bearer HEADER_SENTINEL' },
    body: JSON.stringify({ args: [[{ key: 'private-record', values: { remarks: 'BODY_SENTINEL' } }], actors[index], 'warehouse'] }),
  })));
  for (const [index, response] of replies.entries()) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), ids[index]);
    assert.equal(response.headers.get('x-service-version'), SERVICE_VERSION);
    assert.ok(response.headers.get('x-service-instance-id'));
    assert.equal((await response.json()).result[0].values.description, 'ROW_CONTENT_SENTINEL');
    const completed = captured.find(log => log.event === 'request.completed' && log.requestId === ids[index]);
    assert.equal(completed.bridgeJobId, ids[index]);
    assert.equal(completed.declaredWorkerId, 'worker-' + index);
    assert.equal(completed.declaredActor.name, actors[index]);
    assert.match(completed.declaredActor.identitySource, /not independently authenticated/);
    assert.equal(completed.recordCount, 1);
    assert.equal(completed.resultCount, 1);
    assert.ok(completed.requestBytes > 0 && completed.responseBytes > 0 && completed.durationMs >= 0);
  }
  const text = JSON.stringify(captured);
  for (const sentinel of ['BODY_SENTINEL', 'HEADER_SENTINEL', 'QUERY_SENTINEL', 'ROW_CONTENT_SENTINEL']) assert.ok(!text.includes(sentinel));
});

test('Database failures retain SQLSTATE and missing-column names without leaking row input or details', async () => {
  const missing = await fetch(base + '/api/dockflow/sap/DRESSINGS/page');
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, '42703');
  const missingLog = captured.find(log => log.event === 'request.failed' && log.failure?.code === '42703');
  assert.equal(missingLog.failure.message, 'column "issued" does not exist');
  const invalid = await fetch(base + '/api/dockflow/sap/DRESSINGS/describe');
  await invalid.text();
  const invalidLog = captured.find(log => log.event === 'request.failed' && log.failure?.code === '22P02');
  assert.equal(invalidLog.failure.code, '22P02');
  assert.match(invalidLog.failure.message, /REDACTED/);
  const text = JSON.stringify(captured);
  for (const sentinel of ['PRIVATE_INPUT_SENTINEL', 'PRIVATE_DETAIL_SENTINEL', process.env.POSTGRES_PASSWORD]) assert.ok(!text.includes(sentinel));
});

test('Malformed JSON and synchronous exceptions keep their response status and emit completion logs', async () => {
  const malformed = await fetch(base + '/api/power-tool/write', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"broken":"PRIVATE_JSON_SENTINEL"',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'Invalid JSON');
  const thrown = await fetch(base + '/unknown/PRIVATE_PATH_SENTINEL');
  assert.equal(thrown.status, 409);
  await thrown.text();
  assert.ok(captured.some(log => log.event === 'request.completed' && log.status === 400));
  assert.ok(captured.some(log => log.event === 'request.completed' && log.status === 409));
  assert.ok(!JSON.stringify(captured).includes('PRIVATE_JSON_SENTINEL'));
  assert.ok(!JSON.stringify(captured).includes('PRIVATE_PATH_SENTINEL'));
});

test('Logger redacts credentials recursively, avoids log injection, and preserves counts and diagnostic identifiers', () => {
  const output = [];
  const logger = createLogger({ identity: {}, level: 'info', writer: line => output.push(JSON.parse(line)) });
  logger.debug('hidden.debug');
  logger.info('redaction.test', { headers: { Authorization: 'Bearer RAW_TOKEN_SENTINEL', Cookie: 'COOKIE_SENTINEL' },
    payload: { rows: ['BODY_SENTINEL'] }, databaseAccount: 'test-user', recordCount: 2,
    nested: { value: process.env.COMPANY_API_KEY }, label: 'one\ntwo', count: 4n });
  assert.equal(output.length, 1);
  assert.equal(output[0].headers.Authorization, '[REDACTED]');
  assert.equal(output[0].payload, '[REDACTED]');
  assert.equal(output[0].recordCount, 2);
  assert.equal(output[0].count, '4');
  assert.equal(output[0].label, 'one two');
  assert.ok(!JSON.stringify(output).includes(process.env.COMPANY_API_KEY));
  assert.equal(safeUrl('https://user:pass@example.com/api/health?token=PRIVATE#fragment'), 'https://example.com/api/health');
  assert.equal(safeError({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }).code, 'ECONNREFUSED');
  const summary = operationSummary('page', [0, 50, 'PRIVATE_SEARCH_SENTINEL', 'desc']);
  assert.equal(summary.searchPresent, true);
  assert.ok(!JSON.stringify(summary).includes('PRIVATE_SEARCH_SENTINEL'));
});
