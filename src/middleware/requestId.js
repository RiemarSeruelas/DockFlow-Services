import { randomUUID } from 'node:crypto';
export function requestId(req, res, next) {
  const inbound = req.get('x-request-id');
  req.id = /^[\w.-]{1,128}$/.test(String(inbound || '')) ? inbound : randomUUID();
  res.set('X-Request-ID', req.id);
  next();
}
