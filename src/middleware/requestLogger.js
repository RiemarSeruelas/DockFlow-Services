import { log, addLogContext, runtimeIdentity, withLogContext, responseSummary } from '../utils/logger.js';
export function requestLogger(logger = log) {
  return (req, res, next) => {
    const started = performance.now();
    const health = /\/(health|ready)$/.test(req.path);
    const match = /^\/api\/v1\/(dockflow|power-tool)\//.exec(req.path);
    const fields = { requestId: req.id, method: req.method, operation: health ? 'health' : req.path.split('/').at(-1),
      path: /^\/(?:api\/v1\/(?:dockflow|power-tool|handshake)|health|ready|docs|openapi)/.test(req.path) ? req.path : '[unrecognized-path]',
      jobId: /^[0-9a-f-]{36}$/i.test(String(req.get('x-bridge-job-id') || '')) ? req.get('x-bridge-job-id') : undefined,
      application: match?.[1], peerIp: req.socket.remoteAddress, declaredCaller: String(req.get('x-caller-service') || 'direct-api-client').slice(0,80) };
    res.set('X-Service-Version', runtimeIdentity.serviceVersion);
    res.set('X-Service-Instance-ID', runtimeIdentity.instanceId);
    const summary = {};
    const json = res.json.bind(res);
    res.json = payload => { Object.assign(summary, responseSummary(payload)); return json(payload); };
    res.once('finish', () => withLogContext(fields, () => logger[res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info']('request.completed', { ...summary, status: res.statusCode, durationMs: Math.round((performance.now()-started)*100)/100 })));
    withLogContext(fields, () => { logger.info('request.received'); next(); });
  };
}
export function forwardedActor(req, _res, next) {
  const encoded = req.get('x-actor-context');
  if (encoded && encoded.length <= 2048) {
    try {
      const actor = JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
      if (typeof actor.name === 'string' && actor.name.length <= 120 && typeof actor.role === 'string' && actor.role.length <= 60) addLogContext({ declaredActor: { name: actor.name, role: actor.role, identitySource: 'forwarded by authenticated Ubuntu backend' } });
    } catch { /* Identity metadata never changes operation authorization. */ }
  }
  next();
}
