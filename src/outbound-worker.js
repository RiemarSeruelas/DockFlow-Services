import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { log, withLogContext, SERVICE_VERSION } from './utils/logger.js';

const PATH = /^\/api\/(?:dockflow\/(?:health|sap\/(?:DRESSINGS|SAVOURY)\/(?:describe|sync|page|byKeys|all|forShipment|forClearance|add|save))|power-tool\/(?:health|read|write|log))$/;
const ID = /^[0-9a-f-]{36}$/i;
const RETENTION_MS = 10 * 60_000;
const MAX_BYTES = 64 * 1024 * 1024;
export function isMutation(job) { return job.method === 'POST' && /\/(?:sync|add|save|write|log)$/.test(job.path); }
function problem(code, status) { return Object.assign(new Error(code), { code, status }); }
function delay(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms); signal?.addEventListener('abort', finish, { once: true });
  });
}

// One worker inside the existing Express process. The public bridge wire format
// remains compatible with Ubuntu 13.2; no inbound workstation route is required.
export function createOutboundWorker({ enabled = false, bridgeUrl, key, localUrl, stateDir,
  fetchImpl = fetch, logger = log, signal = new AbortController().signal,
  pollTimeoutMs = 30_000, executionTimeoutMs = 40_000, submissionTimeoutMs = 15_000,
  retryDelayMs = 3_000, workerId = randomUUID() } = {}) {
  let base, local;
  if (enabled) {
    base = new URL(bridgeUrl); local = new URL(localUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/api/integrations/company-bridge')) throw problem('WORKER_HTTPS_BRIDGE_REQUIRED');
    if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.username || local.password || local.pathname !== '/' || local.search || local.hash) throw problem('WORKER_LOCAL_API_REQUIRED');
    if (Buffer.byteLength(String(key || '')) < 32 || /\s/.test(key)) throw problem('WORKER_MATCHING_KEY_REQUIRED');
    if (!stateDir) throw problem('WORKER_STATE_DIRECTORY_REQUIRED');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }
  const state = { enabled, running: false, workerId, bridgeProtocol: 'legacy-parts-1', serviceVersion: SERVICE_VERSION,
    localHandshakeVerified: false, localProtocolVersion: null, lastSuccessfulPollAt: null,
    lastSuccessfulResultAt: null, lastJobAt: null, lastFailureCode: null, lastFailureAt: null, lastFailurePhase: null, stage: 'idle',
    bridgeAuthorization: 'unverified', consecutivePollFailures: 0, activeJobId: null,
    completedJobs: 0, expiredResults: 0, lastSuccessfulReadAt: { dockflow: null, 'power-tool': null } };
  const completed = new Map(); let runningPromise, busy = false;
  const snapshot = () => structuredClone(state);
  const headers = requestId => ({ Authorization: 'Bearer ' + key, 'X-Request-ID': requestId,
    'X-Bridge-Worker-ID': workerId, 'X-Worker-Service-Version': SERVICE_VERSION,
    'X-Worker-Protocol': 'legacy-parts-1', 'X-Caller-Service': 'outbound-company-worker' });
  const timed = timeout => AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  function remember(id, outcome) {
    const json = Buffer.from(JSON.stringify(outcome));
    if (json.length > MAX_BYTES) return remember(id, { status: 502, body: { error: 'Company response exceeds bridge limit', code: 'COMPANY_BRIDGE_RESULT_LIMIT' } });
    const data = gzipSync(json).toString('base64');
    if (data.length > 240_000 * 256) return remember(id, { status: 502, body: { error: 'Company response exceeds bridge limit', code: 'COMPANY_BRIDGE_RESULT_LIMIT' } });
    const entry = { at: Date.now(), bytes: Buffer.byteLength(data), parts: data.match(/.{1,240000}/g) || [''] };
    completed.set(id, entry);
    for (const [oldId, item] of completed) if (Date.now() - item.at > RETENTION_MS || completed.size > 24 || [...completed.values()].reduce((total, item) => total + item.bytes, 0) > 96 * 1024 * 1024) completed.delete(oldId);
    return entry;
  }
  function reserveMutation(job) {
    const files = readdirSync(stateDir).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name));
    for (const name of files) {
      const path = join(stateDir, name); let marker;
      try { marker = JSON.parse(readFileSync(path, 'utf8')); } catch { throw problem('WORKER_REPLAY_GUARD_INVALID'); }
      if (!Number.isFinite(marker.at)) throw problem('WORKER_REPLAY_GUARD_INVALID');
      if (Date.now() - marker.at > RETENTION_MS) unlinkSync(path);
    }
    if (files.length >= 2000) throw problem('WORKER_REPLAY_GUARD_FULL');
    // A persistent, exclusive marker precedes the database call. After a crash,
    // an ambiguous mutation is reported instead of being executed again.
    try { writeFileSync(join(stateDir, job.id + '.json'), JSON.stringify({ at: Date.now(), id: job.id }), { flag: 'wx', mode: 0o600, flush: true }); }
    catch (error) { if (error.code === 'EEXIST') throw problem('COMPANY_BRIDGE_RESULT_UNKNOWN', 409); throw problem('WORKER_REPLAY_GUARD_UNAVAILABLE', 503); }
  }
  async function verifyLocal() {
    const nonce = randomBytes(32).toString('hex');
    const response = await fetchImpl(new URL('api/v1/handshake', local), { method: 'POST',
      headers: { ...headers(workerId), 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce, caller: 'dockflow' }),
      redirect: 'error', signal: timed(7_000) });
    if (!response.ok) throw problem('WORKER_LOCAL_AUTH_REJECTED', response.status);
    const result = await response.json();
    const expected = createHmac('sha256', key).update(`dockflow-services:1:${nonce}:dockflow,power-tool:${result.serviceVersion}`).digest();
    const proof = /^[0-9a-f]{64}$/i.test(String(result.proof)) ? Buffer.from(result.proof, 'hex') : Buffer.alloc(0);
    if (!result.ok || result.service !== 'dockflow-services' || result.serviceVersion !== SERVICE_VERSION || result.protocolVersion !== 1 || result.nonce !== nonce || JSON.stringify(result.applications) !== '["dockflow","power-tool"]' || proof.length !== expected.length || !timingSafeEqual(proof, expected)) throw problem('WORKER_LOCAL_PROTOCOL_MISMATCH');
    state.localHandshakeVerified = true; state.localProtocolVersion = 1;
    logger.info('connection.worker.local_handshake_verified', { workerId, protocolVersion: 1, upstreamServiceVersion: result.serviceVersion });
  }
  async function submit(job, entry, requestId) {
    for (let index = 0; index < entry.parts.length; index++) {
      let accepted = false;
      for (let attempt = 1; attempt <= 3 && !signal.aborted; attempt++) {
        try {
          const response = await fetchImpl(new URL(base.href + '/result/' + job.id + '/part'), { method: 'POST', headers: { ...headers(requestId), 'Content-Type': 'application/json' },
            body: JSON.stringify({ index, total: entry.parts.length, data: entry.parts[index] }), redirect: 'error', signal: timed(submissionTimeoutMs) });
          if (response.status === 404) { state.expiredResults++; logger.warn('connection.worker.result_expired', { jobId: job.id, status: 404, executionWasNotRetried: true }); return false; }
          if (response.status === 401) { state.bridgeAuthorization = 'rejected'; throw problem('WORKER_BRIDGE_AUTH_REJECTED', 401); }
          if (response.status === 400 || response.status === 409) throw problem('WORKER_RESULT_REJECTED', response.status);
          if (![200, 202].includes(response.status)) throw problem('WORKER_RESULT_SUBMISSION_FAILED', response.status);
          const acknowledgement = await response.json();
          if (!acknowledgement.ok || index === entry.parts.length - 1 && (response.status !== 200 || acknowledgement.complete !== true)) throw problem('WORKER_RESULT_BAD_ACK');
          accepted = true; break;
        } catch (error) {
          if (signal.aborted) throw error;
          logger.warn('connection.worker.result_retry', { jobId: job.id, partIndex: index, attempt, status: error.status, failure: { code: error.code || 'WORKER_RESULT_TRANSPORT_FAILED' } });
          if ([400, 401, 409].includes(error.status) || attempt === 3) throw error;
          await delay(retryDelayMs * attempt, signal);
        }
      }
      if (!accepted) return false;
    }
    state.lastSuccessfulResultAt = new Date().toISOString(); state.completedJobs++;
    logger.info('connection.worker.result_submitted', { jobId: job.id, partCount: entry.parts.length, status: 200, acknowledgement: 'bridge accepted result; see upstreamStatus for database outcome' });
    return true;
  }
  async function tick() {
    if (!enabled || signal.aborted) return;
    if (busy) throw problem('WORKER_CONCURRENT_TICK_REJECTED');
    busy = true;
    try {
      state.stage = 'local-handshake';
      if (!state.localHandshakeVerified) await verifyLocal();
      state.stage = 'polling';
      const response = await fetchImpl(new URL(base.href + '/next'), { headers: headers(workerId), redirect: 'error', signal: timed(pollTimeoutMs) });
      if (response.status === 401) { state.bridgeAuthorization = 'rejected'; throw problem('WORKER_BRIDGE_AUTH_REJECTED', 401); }
      if (![200, 204].includes(response.status)) throw problem('WORKER_POLL_FAILED', response.status);
      const recovered = state.consecutivePollFailures > 0 || state.bridgeAuthorization !== 'authenticated';
      state.bridgeAuthorization = 'authenticated'; state.lastSuccessfulPollAt = new Date().toISOString(); state.consecutivePollFailures = 0; state.lastFailureCode = null;
      if (recovered) logger.info('connection.worker.poll_recovered', { workerId, status: response.status });
      if (response.status === 204) return;
      const { job } = await response.json();
      if (!job || !ID.test(String(job.id)) || !PATH.test(String(job.path)) || !['GET', 'POST'].includes(job.method)) throw problem('WORKER_INVALID_JOB');
      const application = job.path.includes('/dockflow/') ? 'dockflow' : 'power-tool';
      const requestId = /^[\w.-]{1,128}$/.test(String(job.requestId || '')) ? job.requestId : job.id;
      state.stage = 'processing';
      const started = performance.now(); state.activeJobId = job.id; state.lastJobAt = new Date().toISOString();
      await withLogContext({ requestId, jobId: job.id, workerId, application, operation: job.path.split('/').at(-1) }, async () => {
        logger.info('connection.worker.job_claimed', { path: job.path, method: job.method, correlationSource: job.requestId ? 'ubuntu-request' : 'legacy-job-id' });
        let entry = completed.get(job.id);
        if (entry) logger.warn('connection.worker.cached_result_replayed', { executionWasNotRetried: true });
        else {
          let outcome;
          try {
            if (isMutation(job)) reserveMutation(job);
            const forwarded = /^[A-Za-z0-9_-]{1,2048}$/.test(String(job.actorContext || '')) ? { 'X-Actor-Context': job.actorContext } : {};
            const result = await fetchImpl(new URL(job.path.replace(/^\/api\//, '/api/v1/'), local), { method: job.method,
              headers: { ...headers(requestId), 'X-Bridge-Job-ID': job.id, ...forwarded, ...(job.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
              body: job.method === 'POST' ? JSON.stringify(job.data ?? {}) : undefined, redirect: 'error', signal: timed(executionTimeoutMs) });
            const body = await result.json();
            outcome = { status: result.status, body };
            if (result.ok && !isMutation(job) && !job.path.endsWith('/health')) state.lastSuccessfulReadAt[application] = new Date().toISOString();
          } catch (error) {
            // HTTP cancellation cannot prove that an already-started write did
            // not commit. The durable marker prevents a second execution.
            outcome = { status: error.status === 409 ? 409 : 503, body: { error: isMutation(job) ? 'Company operation outcome is uncertain; reload before retrying' : 'Company service did not complete the operation', code: error.code || 'COMPANY_WORKER_LOCAL_UNAVAILABLE' } };
          }
          logger[outcome.status >= 400 ? 'warn' : 'info']('connection.worker.job_processed', { upstreamStatus: outcome.status, durationMs: Math.round(performance.now() - started), failure: outcome.status >= 400 ? { code: outcome.body?.code || 'COMPANY_SERVICE_ERROR' } : undefined });
          entry = remember(job.id, outcome);
        }
        state.stage = 'submitting-result';
        await submit(job, entry, requestId);
      });
    } catch (error) { error.phase ||= state.stage; throw error; }
    finally { busy = false; state.activeJobId = null; state.stage = 'idle'; }
  }
  function run() {
    if (runningPromise) return runningPromise;
    runningPromise = (async () => {
      logger.info('initialization.worker.configured', { enabled, workerId, bridgeProtocol: state.bridgeProtocol, ...(enabled ? { bridgeOrigin: base.origin, bridgePath: base.pathname } : {}) });
      if (!enabled) return;
      state.running = true; logger.info('connection.worker.started', { workerId });
      try {
        while (!signal.aborted) {
          try { await tick(); }
          catch (error) {
            if (signal.aborted) break;
            state.consecutivePollFailures++; state.lastFailureCode = error.code || 'WORKER_TRANSPORT_FAILED'; state.lastFailureAt = new Date().toISOString(); state.lastFailurePhase = error.phase || 'cycle';
            logger.error(state.lastFailurePhase === 'polling' ? 'connection.worker.poll_failed' : 'connection.worker.cycle_failed', { workerId, attempt: state.consecutivePollFailures, status: error.status,
              phase: state.lastFailurePhase, failure: { code: state.lastFailureCode }, nextRetryMs: Math.min(30_000, retryDelayMs * state.consecutivePollFailures) });
            await delay(Math.min(30_000, retryDelayMs * state.consecutivePollFailures), signal);
          }
        }
      } finally { state.running = false; logger.info('connection.worker.stopped', { workerId, activeJobId: state.activeJobId }); }
    })();
    return runningPromise;
  }
  return { run, tick, snapshot };
}
