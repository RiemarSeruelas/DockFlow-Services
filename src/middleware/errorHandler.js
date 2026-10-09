import { log, safeError } from '../utils/logger.js';
export function notFound(req, res) { res.status(404).json({ error: 'not found', requestId: req.id }); }
export function errorHandler(logger = log) {
  return (err, req, res, _next) => {
    const failure = safeError(err);
    logger.error('request.failed', { failure });
    if (res.headersSent) return res.destroy();
    const declared = Number(err.status || err.statusCode);
    const status = err.type === 'entity.parse.failed' ? 400 : err.code === '57014' ? 504 : declared >= 400 && declared <= 599 ? declared : err.code ? 503 : 500;
    const error = status < 500 ? err.type === 'entity.parse.failed' ? 'Invalid JSON' : failure.message : status === 504 ? 'query timed out' : 'workstation service unavailable';
    res.status(status).json({ error, code: failure.code || (status === 400 ? 'INVALID_REQUEST' : 'SERVICE_ERROR'), requestId: req.id });
  };
}
