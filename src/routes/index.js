import { Router } from 'express';
import express from 'express';
import { apiKeyAuth } from '../middleware/apiKeyAuth.js';
import { docsRoutes } from './docs.routes.js';
import { healthRoutes } from './health.routes.js';
import { v1Routes } from './v1.routes.js';
export function createRouter(deps) {
  const router=Router();router.use(healthRoutes(deps));
  if(deps.config.docsEnabled) router.use(docsRoutes());
  // Protect every v1 route before buffering a request body.
  router.use('/api/v1',apiKeyAuth(deps.config.apiKeys),express.json({limit:'64mb',strict:true}),v1Routes(deps));
  return router;
}
