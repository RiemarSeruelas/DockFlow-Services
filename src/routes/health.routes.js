import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { SERVICE_VERSION } from '../utils/logger.js';
export function healthRoutes({services}) {
  const router=Router();
  router.get('/health',(_req,res)=>res.json({status:'ok',service:'dockflow-services',version:SERVICE_VERSION,transport:'direct-express-api'}));
  router.get('/ready',asyncHandler(async(_req,res)=>{
    const dockflow=await services.dockflow.health();let powerTool;
    try{powerTool={ok:!!(await services.powerTool.ready()).ok};}catch{powerTool={ok:false};}
    const ready=dockflow.ok&&powerTool.ok;
    res.status(ready?200:503).json({status:ready?'ready':'unavailable',services:{dockflow:{ok:dockflow.ok},powerTool}});
  }));
  return router;
}
