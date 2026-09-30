import http from 'node:http';
import { addLogContext, log, requestContext, responseSummary, runtimeIdentity, safeError, withLogContext } from './logger.js';

export function send(response, status, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  if (response.logMetadata) Object.assign(response.logMetadata, responseSummary(payload), { responseBytes: data.length });
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(data);
}

export async function body(request, maximum = 64 * 1024 * 1024) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('Use application/json'), { status: 415 });
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    addLogContext({ requestBytes: length });
    if (length > maximum) throw Object.assign(new Error('Request is too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

export function listen(port, handler, { host = '0.0.0.0' } = {}) {
  const server = http.createServer((request, response) => {
    const fields = requestContext(request);
    const started = performance.now();
    response.logMetadata = {};
    response.setHeader('X-Request-ID', fields.requestId);
    response.setHeader('X-Service-Version', runtimeIdentity.serviceVersion);
    response.setHeader('X-Service-Instance-ID', runtimeIdentity.instanceId);
    const durationMs = () => Math.round((performance.now() - started) * 100) / 100;
    response.once('finish', () => withLogContext(fields, () => {
      const level = response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'info';
      log[level]('request.completed', { ...response.logMetadata, status: response.statusCode, durationMs: durationMs() });
    }));
    response.once('close', () => {
      if (!response.writableFinished) withLogContext(fields, () => log.warn('request.aborted', { durationMs: durationMs() }));
    });
    withLogContext(fields, () => {
      log.info('request.received');
      Promise.resolve().then(() => handler(request, response)).catch(error => {
        log.error('request.failed', { failure: safeError(error) });
        if (!response.headersSent) {
          send(response, Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 503, {
            error: String(error.message || 'Service unavailable').slice(0, 500),
            code: String(error.code || '').slice(0, 20),
          });
        } else response.destroy();
      });
    });
  });
  server.requestTimeout = 65_000;
  server.on('error', error => {
    log.error('service.listen_failed', { port: Number(port), failure: safeError(error) });
    process.exitCode = 1;
  });
  server.listen(Number(port), host, () => log.info('service.listening', { port: server.address().port, bindHost: host }));
  return server;
}
