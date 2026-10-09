import 'dotenv/config';
import { readFileSync } from 'node:fs';
const secretName = /password|passcode|secret|token|api.?key|authorization|cookie|credential/i;
const secrets = Object.entries(process.env).filter(([name, value]) => secretName.test(name) && value?.length >= 4).flatMap(([, value]) => [value, ...value.split(',')]).filter(value => value.length >= 4);
const fields = new Set(['timestamp','category','event','service','serviceVersion','loggingVersion','buildId','requestId','jobId','workerId','application','operation','method','status','upstreamStatus','durationMs','queueWaitMs','processingMs','elapsedMs','pendingCount','partIndex','partCount','receivedPartCount','attempt','nextRetryMs','failure','code','enabled','running','bridgeProtocol','workerProtocol','upstreamServiceVersion','localHandshakeVerified','localProtocolVersion','lastSuccessfulPollAt','lastSuccessfulResultAt','lastJobAt','lastFailureAt','lastFailurePhase','stage','lastFailureCode','bridgeAuthorization','consecutivePollFailures','activeJobId','completedJobs','expiredResults','lastSuccessfulReadAt','dockflow','power-tool','ok','version','protocolVersion','approvalSafetyVersion','worksheetVersion','provider','loggingAvailable','areas','DRESSINGS','SAVOURY','hasRecords','worker','lastAuthenticatedPollAt','lastWorkerId','lastWorkerServiceVersion','lastWorkerProtocol','lastResultAt','timedOutJobs','claimedCount','oldestPendingAgeMs','queueTimeoutMs','readLeaseMs','rejectedAuthCount','redelivered','mutating','executionWasNotRetried','phase']);
function clean(value) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    let result = value; for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
    return result.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/(https?:\/\/|postgres(?:ql)?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map(clean);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key) && !secretName.test(key)).map(([key, item]) => [key, clean(item)]));
  return undefined;
}
if (process.argv.includes('--logs-stdin')) {
  for (const line of readFileSync(0, 'utf8').split('\n')) {
    try { const item = JSON.parse(line.slice(line.indexOf('{'))); if (['INITIALIZATION', 'USER_REQUEST', 'CONNECTION'].includes(item.category)) console.log(JSON.stringify(clean(item))); }
    catch { /* Never copy unstructured log lines into a shareable bundle. */ }
  }
} else {
  const port = Number(process.env.PORT || 5230), key = String(process.env.COMPANY_API_KEY || process.env.API_KEYS?.split(',')[0] || '').trim();
  const base = `http://127.0.0.1:${port}`;
  const report = { collectedAt: new Date().toISOString(), port, productionModified: false,
    configuration: { localKeyConfigured: !!key, localKeyBytes: Buffer.byteLength(key), outboundEnabled: process.env.OUTBOUND_WORKER_ENABLED === 'true', bridgeUrlConfigured: !!process.env.UBUNTU_BRIDGE_URL } };
  async function call(path, body) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20_000) });
    return { status: response.status, value: await response.json() };
  }
  for (const [name, path] of [['expressHttp', '/health'], ['worker', '/api/v1/diagnostics'], ['dockflowDatabase', '/api/v1/dockflow/health'], ['powerToolDatabase', '/api/v1/power-tool/health']]) {
    try { const { status, value } = await call(path); report[name] = { status, ...clean(value) }; }
    catch { report[name] = { ok: false, code: 'LOCAL_API_UNREACHABLE' }; }
  }
  report.databaseReads = {};
  for (const area of ['DRESSINGS', 'SAVOURY']) {
    try { const { status, value } = await call('/api/v1/dockflow/sap/' + area + '/page', { args: [0, 1, '', {}] }); report.databaseReads[area] = { status, shapeValid: Array.isArray(value.result?.rows) && Array.isArray(value.result?.columns), rowCount: value.result?.rows?.length }; }
    catch { report.databaseReads[area] = { ok: false, code: 'SAP_READ_FAILED' }; }
  }
  try { const { status, value } = await call('/api/v1/power-tool/read', {}); report.databaseReads.powerTool = { status, shapeValid: ['categories', 'legacyCategories', 'staffAccounts', 'requests', 'items'].every(name => Array.isArray(value.result?.[name])), counts: Object.fromEntries(['categories','requests','items'].map(name => [name,value.result?.[name]?.length])) }; }
  catch { report.databaseReads.powerTool = { ok: false, code: 'POWER_TOOL_READ_FAILED' }; }
  if (process.env.UBUNTU_BRIDGE_URL) {
    try {
      const bridge = new URL(process.env.UBUNTU_BRIDGE_URL.replace(/\/+$/, '') + '/status');
      if (bridge.protocol !== 'https:' || bridge.username || bridge.password || bridge.search || bridge.hash) throw Error();
      const response = await fetch(bridge, { headers: { Authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(8_000) });
      report.ubuntuBridge = { status: response.status, ...(response.status === 200 ? clean(await response.json()) : { code: response.status === 404 ? 'STATUS_UNAVAILABLE_ON_13_2' : response.status === 401 ? 'COMPANY_API_AUTH' : 'BRIDGE_STATUS_UNAVAILABLE' }) };
    } catch { report.ubuntuBridge = { ok: false, code: 'BRIDGE_STATUS_UNREACHABLE' }; }
  }
  console.log(JSON.stringify(report, null, 2));
}
