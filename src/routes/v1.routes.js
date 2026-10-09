import { Router } from 'express';
import { forwardedActor } from '../middleware/requestLogger.js';
import { handshakeRoutes } from './handshake.routes.js';
import { dockflowRoutes } from '../modules/dockflow/dockflow.routes.js';
import { powerToolRoutes } from '../modules/power-tool/power-tool.routes.js';
export function v1Routes({config,services,pools}) {
  const router=Router();
  router.use(forwardedActor);
  router.use('/handshake',handshakeRoutes());
  router.use('/dockflow',dockflowRoutes({service:services.dockflow,settings:{...config.dockflow,pool:pools.dockflow}}));
  router.use('/power-tool',powerToolRoutes({service:services.powerTool,settings:{...config.powerTool,pool:pools.powerTool}}));
  return router;
}
