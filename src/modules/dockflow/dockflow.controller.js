import { validateOperation } from './dockflow.validator.js';
import { addLogContext, log, operationSummary, reportConnectionState, runtimeIdentity, SERVICE_VERSION } from '../../utils/logger.js';
export function createDockflowController({ service, settings }) {
  return {
    async health(_req,res) {
      const status=await service.health();
      for(const [area,state] of Object.entries(status.areas)) reportConnectionState('dockflow-'+area,state.ok,{area,...settings.logFields,table:settings.tables[area]});
      res.status(status.ok?200:503).json({...status,serviceVersion:SERVICE_VERSION,protocolVersion:1,diagnostics:runtimeIdentity});
    },
    async operation(req,res) {
      const {area,operation}=req.params;
      const checked=validateOperation(area,operation,req.body);
      if(checked.errors) return res.status(400).json({error:'Invalid operation',details:checked.errors,requestId:req.id});
      addLogContext({...settings.logFields,area,table:settings.tables[area],operation,...operationSummary(operation,checked.value)});
      log.info('request.operation.started');
      const result=await service.execute(area,operation,checked.value);
      res.json({ok:true,result:result??null});
    },
  };
}
