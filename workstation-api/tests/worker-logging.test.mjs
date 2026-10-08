import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { createLogger } from '../server/logger.js';
import { createCompanyWorker } from '../server/worker-core.js';

const key = 'TEST_COMPANY_KEY_NEVER_PRINT_THIS_123456789';
const base = 'https://ubuntu.example.test/dockflow/api/integrations/company-bridge';
const jobId = '11111111-1111-4111-8111-111111111111';
const json = (payload, status = 200, headers = {}) => new Response(JSON.stringify(payload), { status, headers });

test('Bridge job keeps its ID across forwarding, replies and replay; logs never contain payloads or key', async () => {
  const output = [], forwarded = [], delivered = [];
  const job = { id: jobId, method: 'POST', path: '/api/dockflow/sap/DRESSINGS/page', data: { args: [0, 1, 'PRIVATE_SEARCH_SENTINEL', 'desc'] } };
  const outcome = { ok: true, result: { rows: [{ values: { remarks: 'PRIVATE_ROW_SENTINEL' } }], hasMore: true,
    columns: [['remarks', 'REMARKS', 20, 'remarks']], source: { area: 'DRESSINGS', table: 'SAPAnalysisDressings', serviceVersion: '13.1.0' } } };
  const fetchImpl = async (url, options) => {
    if (url === base + '/next') return json({ job });
    if (url.startsWith('http://dockflow-db:8081/')) {
      forwarded.push({ url, options });
      return json(outcome, 200, { 'X-Service-Version': '13.1.0', 'X-Service-Instance-ID': 'fixture-db-instance' });
    }
    delivered.push(JSON.parse(options.body));
    return json({ ok: true });
  };
  const worker = createCompanyWorker({ key, base, fetchImpl,
    logger: createLogger({ identity: {}, level: 'debug', writer: line => output.push(JSON.parse(line)) }), pause: async () => {} });
  await worker.tick();
  await worker.tick();
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].options.headers['X-Request-ID'], jobId);
  assert.equal(forwarded[0].options.headers['X-Bridge-Job-ID'], jobId);
  assert.ok(forwarded[0].options.headers['X-Bridge-Worker-ID']);
  assert.equal(forwarded[0].options.headers['X-Caller-Service'], 'company-worker');
  assert.deepEqual(JSON.parse(forwarded[0].options.body), job.data);
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(delivered[0].data, 'base64'))), { status: 200, body: outcome });
  assert.ok(output.some(log => log.event === 'job.replayed'));
  const result = output.find(log => log.event === 'job.forward.completed');
  assert.equal(result.rowCount, 1);
  assert.equal(result.upstreamServiceVersion, '13.1.0');
  assert.equal(result.upstreamInstanceId, 'fixture-db-instance');
  for (const event of output.filter(log => log.event.startsWith('job.'))) assert.equal(event.bridgeJobId, jobId);
  const text = JSON.stringify(output);
  for (const sentinel of [key, 'PRIVATE_ROW_SENTINEL', 'PRIVATE_SEARCH_SENTINEL', delivered[0].data]) assert.ok(!text.includes(sentinel));
});

test('Result delivery retries and multi-part transfer preserve order without logging encoded data', async () => {
  const events = [], parts = [];
  let attempts = 0;
  const worker = createCompanyWorker({ key, base, pause: async () => {},
    logger: createLogger({ identity: {}, level: 'debug', writer: line => events.push(JSON.parse(line)) }),
    fetchImpl: async (_url, options) => {
      attempts++;
      if (attempts <= 2) return json({ error: 'temporary' }, 503);
      parts.push(JSON.parse(options.body));
      return json({ ok: true });
    },
  });
  const result = await worker.returnResult(jobId, 'A'.repeat(240001));
  assert.equal(result.delivered, true);
  assert.equal(attempts, 4);
  assert.deepEqual(parts.map(part => [part.index, part.total, part.data.length]), [[0, 2, 240000], [1, 2, 1]]);
  assert.equal(events.filter(log => log.event === 'job.result.retry').length, 2);
  assert.ok(!JSON.stringify(events).includes('A'.repeat(100)));
});

test('Expired jobs are logged as undelivered and network failures retain useful cause codes', async () => {
  const events = [];
  const logger = createLogger({ identity: {}, level: 'info', writer: line => events.push(JSON.parse(line)) });
  const expired = createCompanyWorker({ key, base, logger, fetchImpl: async () => json({ error: 'expired' }, 404) });
  assert.deepEqual(await expired.returnResult(jobId, 'AAAA'), { delivered: false, expired: true });
  assert.ok(events.some(log => log.event === 'job.result.expired'));
  const failed = createCompanyWorker({ key, base, logger, fetchImpl: async () => {
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  } });
  const result = await failed.execute({ id: jobId, path: '/api/dockflow/health', method: 'GET' });
  assert.equal(result.status, 503);
  assert.equal(events.find(log => log.event === 'job.forward.failed').failure.code, 'ECONNREFUSED');
});

test('Idle bridge polls stay at debug level, and invalid configuration is rejected before fetching', async () => {
  const events = [];
  const worker = createCompanyWorker({ key, base, logger: createLogger({ identity: {}, level: 'info', writer: line => events.push(JSON.parse(line)) }),
    fetchImpl: async () => new Response(null, { status: 204 }) });
  await worker.tick();
  await worker.tick();
  assert.equal(events.filter(log => log.event === 'bridge.connected').length, 1);
  assert.ok(!events.some(log => log.event.startsWith('bridge.poll')));
  assert.throws(() => createCompanyWorker({ key, base: 'https://user:password@example.test/api' }), /approved HTTPS/);
});
