import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { createPowerToolController } from './power-tool.controller.js';
export function powerToolRoutes(deps) {
  const router=Router(),controller=createPowerToolController(deps);
  router.get('/health',asyncHandler(controller.health));
  router.post('/:operation',asyncHandler(controller.operation));
  return router;
}
