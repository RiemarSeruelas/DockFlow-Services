import { createHash, timingSafeEqual } from 'node:crypto';
import { addLogContext, log } from '../utils/logger.js';
const digest = value => createHash('sha256').update(value).digest();
export function apiKeyAuth(apiKeys) {
  const allowed = apiKeys.map(digest);
  return (req, res, next) => {
    const authorization = req.get('authorization');
    const bearer = authorization ? /^Bearer ([^\s]+)$/i.exec(authorization)?.[1] : undefined;
    const header = req.get('x-api-key');
    const candidate = bearer || (!authorization ? header : undefined);
    let ok = false;
    if (candidate && (!header || !bearer || digest(header).equals(digest(bearer)))) for (const key of allowed) ok = timingSafeEqual(digest(candidate), key) || ok;
    if (!ok) {
      log.warn('request.authorization_failed');
      return res.status(401).json({ error: 'unauthorized', code: 'COMPANY_API_AUTH', requestId: req.id });
    }
    req.integrationKey = candidate;
    addLogContext({ callerAuthenticated: true });
    next();
  };
}
