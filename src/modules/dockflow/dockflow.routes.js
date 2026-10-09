import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { createDockflowController } from './dockflow.controller.js';
export function dockflowRoutes(deps) {
  const router=Router(),controller=createDockflowController(deps);
  router.get('/health',asyncHandler(controller.health));
  router.post('/sap/:area/:operation',asyncHandler(controller.operation));
  return router;
}
