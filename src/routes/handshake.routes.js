import { Router } from 'express';
import { createHmac } from 'node:crypto';
import { log, runtimeIdentity, SERVICE_VERSION } from '../utils/logger.js';
export const PROTOCOL_VERSION = 1;
export function handshakeProof(key, nonce, version = SERVICE_VERSION) {
  return createHmac('sha256',key).update(`dockflow-services:1:${nonce}:dockflow,power-tool:${version}`).digest('hex');
}
export function handshakeRoutes() {
  const router = Router();
  router.post('/', (req,res) => {
    const { nonce, caller } = req.body || {};
    if (typeof nonce !== 'string' || !/^[0-9a-f]{32,128}$/i.test(nonce) || !['dockflow','power-tool'].includes(caller)) return res.status(400).json({ error: 'nonce must be 32-128 hex characters and caller must be dockflow or power-tool', requestId: req.id });
    log.info('connection.handshake.accepted', { declaredCaller: caller });
    res.json({ ok:true, service:'dockflow-services', serviceVersion:SERVICE_VERSION, protocolVersion:PROTOCOL_VERSION,
      applications:['dockflow','power-tool'], nonce, proof:handshakeProof(req.integrationKey,nonce), diagnostics:runtimeIdentity, requestId:req.id });
  });
  return router;
}
