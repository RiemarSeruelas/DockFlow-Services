import express from 'express';
import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler,notFound } from './middleware/errorHandler.js';
import { createRouter } from './routes/index.js';
import { createDockflowService } from './modules/dockflow/dockflow.service.js';
import { createPowerToolService } from './modules/power-tool/power-tool.service.js';
export function createApp({config,pools,services,logger}) {
  services ||= {dockflow:createDockflowService({...config.dockflow,pool:pools.dockflow}),powerTool:createPowerToolService({...config.powerTool,pool:pools.powerTool})};
  const app=express();app.disable('x-powered-by');app.set('query parser','simple');
  app.use(requestId);app.use(requestLogger(logger));
  app.use(createRouter({config,pools,services}));app.use(notFound);app.use(errorHandler(logger));
  return app;
}
