import { validatePowerToolOperation } from './power-tool.validator.js';
import { addLogContext,log,reportConnectionState,runtimeIdentity,safeError,SERVICE_VERSION } from '../../utils/logger.js';
export function createPowerToolController({service,settings}) {
  return {
    async health(_req,res) {
      try {
        const database=await service.ready();reportConnectionState('power-tool-database',true,settings.logFields);
        res.json({ok:true,provider:database.provider,loggingAvailable:database.loggingAvailable,approvalSafetyVersion:'13.2',serviceVersion:SERVICE_VERSION,protocolVersion:1,diagnostics:runtimeIdentity});
      }catch(error) {
        reportConnectionState('power-tool-database',false,{...settings.logFields,failure:safeError(error)});
        res.status(503).json({ok:false,code:String(error.code||''),error:'Power Tool database is unavailable',serviceVersion:SERVICE_VERSION,protocolVersion:1,diagnostics:runtimeIdentity});
      }
    },
    async operation(req,res) {
      const operation=req.params.operation,checked=validatePowerToolOperation(operation,req.body);
      if(checked.errors) return res.status(400).json({error:'Invalid operation',details:checked.errors,requestId:req.id});
      addLogContext({...settings.logFields,operation});log.info('request.operation.started');
      res.json({ok:true,result:await service.execute(operation,checked.value)});
    },
  };
}
