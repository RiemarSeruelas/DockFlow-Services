import { gzipSync } from 'node:zlib';
import { log, operationFor, operationSummary, responseSummary, runtimeIdentity, safeError, safeUrl, withLogContext } from './logger.js';

export function createCompanyWorker({ key, base, fetchImpl = fetch, logger = log,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), signal } = {}) {
  base = String(base || '').replace(/\/$/, '');
  let url;
  try { url = new URL(base); } catch { /* handled by the fixed configuration error below */ }
  if (Buffer.byteLength(String(key || '')) < 32 || url?.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Set a 32+ character COMPANY_API_KEY and an approved HTTPS UBUNTU_BRIDGE_URL without credentials, query, or fragment.');
  }
  const auth = { Authorization: 'Bearer ' + key };
  const completed = new Map();
  const timeout = ms => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  let connected = false;

  async function receive() {
    const started = performance.now();
    logger.debug('bridge.poll.started', { method: 'GET', targetUrl: safeUrl(base + '/next') });
    const response = await fetchImpl(base + '/next', { headers: auth, signal: timeout(30_000), redirect: 'error' });
    logger.debug('bridge.poll.completed', { method: 'GET', status: response.status, durationMs: Math.round(performance.now() - started) });
    if (response.status !== 204 && !response.ok) throw Object.assign(new Error('Ubuntu bridge poll returned HTTP ' + response.status), { status: response.status });
    if (!connected) {
      connected = true;
      logger.info('bridge.connected', { method: 'GET', targetUrl: safeUrl(base + '/next'), status: response.status });
    }
    if (response.status === 204) return null;
    const payload = await response.json();
    if (!payload.job || !/^[0-9a-f-]{36}$/i.test(payload.job.id)) throw new Error('Invalid Ubuntu bridge job');
    return payload.job;
  }

  async function execute(job) {
    const target = job.path?.startsWith('/api/dockflow/') ? 'http://dockflow-db:8081'
      : job.path?.startsWith('/api/power-tool/') ? 'http://power-tool-db:8082' : null;
    if (!target || !['GET', 'POST'].includes(job.method)) {
      logger.warn('job.rejected', { reason: 'Unknown company operation' });
      return { status: 400, body: { error: 'Unknown company operation' } };
    }
    const started = performance.now();
    const headers = {
      'X-Request-ID': job.id, 'X-Bridge-Job-ID': job.id,
      'X-Bridge-Worker-ID': runtimeIdentity.instanceId, 'X-Caller-Service': 'company-worker',
      ...(job.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    };
    logger.info('job.forward.started', { targetUrl: safeUrl(target + job.path),
      ...operationSummary(operationFor(job.path).operation, job.data?.args) });
    try {
      const response = await fetchImpl(target + job.path, {
        method: job.method, headers,
        body: job.method === 'POST' ? JSON.stringify(job.data) : undefined,
        signal: timeout(40_000), redirect: 'error',
      });
      const payload = await response.json();
      logger[response.ok ? 'info' : 'error']('job.forward.completed', {
        status: response.status, durationMs: Math.round(performance.now() - started),
        upstreamServiceVersion: response.headers?.get('x-service-version') || payload.serviceVersion || payload.result?.source?.serviceVersion || 'not-reported',
        upstreamInstanceId: response.headers?.get('x-service-instance-id') || 'not-reported',
        ...responseSummary(payload),
      });
      return { status: response.status, body: payload };
    } catch (error) {
      logger.error('job.forward.failed', { durationMs: Math.round(performance.now() - started), failure: safeError(error) });
      return { status: 503, body: { error: String(error.message || 'Workstation database unavailable').slice(0, 400) } };
    }
  }

  async function returnResult(id, encoded) {
    const started = performance.now();
    const size = 240_000;
    const total = Math.ceil(encoded.length / size) || 1;
    if (total > 256) throw new Error('Company result exceeds the 64 MB bridge limit');
    logger.info('job.result.started', { method: 'POST', partCount: total, encodedBytes: Buffer.byteLength(encoded) });
    for (let index = 0; index < total; index++) {
      const data = encoded.slice(index * size, (index + 1) * size);
      let sent = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          logger.debug('job.result.part_started', { partIndex: index, partCount: total, attempt: attempt + 1 });
          const response = await fetchImpl(base + '/result/' + id + '/part', {
            method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ index, total, data }), signal: timeout(15_000), redirect: 'error',
          });
          if (response.status === 404) {
            logger.warn('job.result.expired', { status: 404, partIndex: index, partCount: total });
            return { delivered: false, expired: true };
          }
          if (!response.ok) throw Object.assign(new Error('Ubuntu result endpoint returned HTTP ' + response.status), { status: response.status });
          logger.debug('job.result.part_completed', { status: response.status, partIndex: index, partCount: total, attempt: attempt + 1 });
          sent = true;
          break;
        } catch (error) {
          logger[attempt === 2 ? 'error' : 'warn']('job.result.retry', { partIndex: index, attempt: attempt + 1, failure: safeError(error) });
          if (signal?.aborted || attempt === 2) throw error;
          await pause(500 * (attempt + 1));
        }
      }
      if (!sent) throw new Error('Could not deliver a result part');
    }
    logger.info('job.result.completed', { partCount: total, durationMs: Math.round(performance.now() - started) });
    return { delivered: true, expired: false };
  }

  async function tick() {
    const job = await receive();
    if (!job) return;
    const now = Date.now();
    for (const [id, value] of completed) if (now - value.at > 10 * 60_000) completed.delete(id);
    const fields = { requestId: job.id, bridgeJobId: job.id, method: job.method, ...operationFor(job.path),
      declaredCaller: 'ubuntu-company-bridge', callerIdentitySource: 'bridge job; original browser user is not supplied' };
    return withLogContext(fields, async () => {
      logger.info('job.received');
      let cached = completed.get(job.id);
      if (!cached) {
        const outcome = await execute(job);
        cached = { at: now, encoded: gzipSync(Buffer.from(JSON.stringify(outcome))).toString('base64'), status: outcome.status };
        completed.set(job.id, cached);
        if (completed.size > 24) completed.delete(completed.keys().next().value);
      } else logger.info('job.replayed', { cachedStatus: cached.status });
      const delivery = await returnResult(job.id, cached.encoded);
      logger.info('job.completed', { status: cached.status, ...delivery, durationMs: Date.now() - now });
    });
  }

  async function run() {
    logger.info('worker.started', { bridgeUrl: safeUrl(base), databaseTargets: ['http://dockflow-db:8081', 'http://power-tool-db:8082'],
      callerIdentitySource: 'Ubuntu bridge jobs do not contain the original browser user identity' });
    while (!signal?.aborted) {
      try { await tick(); }
      catch (error) {
        if (signal?.aborted) break;
        connected = false;
        logger.error('bridge.loop_failed', { failure: safeError(error) });
        await pause(3000);
      }
    }
    logger.info('worker.stopped');
  }
  return { receive, execute, returnResult, tick, run };
}
