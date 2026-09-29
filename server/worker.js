import { gzipSync } from 'node:zlib';

const key = String(process.env.COMPANY_API_KEY || '');
const base = String(process.env.UBUNTU_BRIDGE_URL || '').replace(/\/$/, '');
if (Buffer.byteLength(key) < 32 || !base.startsWith('https://') || new URL(base).username || new URL(base).password) {
  throw new Error('Set a 32+ character COMPANY_API_KEY and an approved HTTPS UBUNTU_BRIDGE_URL.');
}
const auth = { Authorization: `Bearer ${key}` };
const completed = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function receive() {
  const response = await fetch(base + '/next', { headers: auth, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`Ubuntu bridge poll returned HTTP ${response.status}`);
  const body = await response.json();
  if (!body.job || !/^[0-9a-f-]{36}$/i.test(body.job.id)) throw new Error('Invalid Ubuntu bridge job');
  return body.job;
}

async function execute(job) {
  const target = job.path.startsWith('/api/dockflow/')
    ? 'http://dockflow-db:8081'
    : job.path.startsWith('/api/power-tool/')
      ? 'http://power-tool-db:8082'
      : null;
  if (!target || !['GET', 'POST'].includes(job.method)) return { status: 400, body: { error: 'Unknown company operation' } };
  try {
    const response = await fetch(target + job.path, {
      method: job.method,
      headers: job.method === 'POST' ? { 'Content-Type': 'application/json' } : {},
      body: job.method === 'POST' ? JSON.stringify(job.data) : undefined,
      signal: AbortSignal.timeout(40_000),
      redirect: 'error',
    });
    const body = await response.json();
    return { status: response.status, body };
  } catch (error) {
    return { status: 503, body: { error: String(error.message || 'Workstation database unavailable').slice(0, 400) } };
  }
}

async function returnResult(id, encoded) {
  const size = 240_000;
  const total = Math.ceil(encoded.length / size) || 1;
  if (total > 256) throw new Error('Company result exceeds the 64 MB bridge limit');
  for (let index = 0; index < total; index++) {
    const data = encoded.slice(index * size, (index + 1) * size);
    let sent = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${base}/result/${id}/part`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ index, total, data }),
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
        });
        if (response.status === 404) return;
        if (!response.ok) throw new Error(`Ubuntu result endpoint returned HTTP ${response.status}`);
        sent = true;
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await sleep(500 * (attempt + 1));
      }
    }
    if (!sent) throw new Error('Could not deliver a result part');
  }
}

console.log('Company PostgreSQL worker is polling the existing Ubuntu HTTPS endpoint.');
for (;;) {
  try {
    const job = await receive();
    if (!job) continue;
    const now = Date.now();
    for (const [id, value] of completed) if (now - value.at > 10 * 60_000) completed.delete(id);
    let cached = completed.get(job.id);
    if (!cached) {
      const outcome = await execute(job);
      cached = { at: now, encoded: gzipSync(Buffer.from(JSON.stringify(outcome))).toString('base64') };
      completed.set(job.id, cached);
      if (completed.size > 24) completed.delete(completed.keys().next().value);
    }
    await returnResult(job.id, cached.encoded);
  } catch (error) {
    console.error(`[company worker] ${error.message}`);
    await sleep(3000);
  }
}
