import 'dotenv/config';
import { loadConfig } from './src/config.js';
import { createPools,ping } from './src/db.js';
import { createApp } from './src/app.js';
import { log,reportConnectionState,runtimeIdentity,safeError } from './src/utils/logger.js';
let config;
try{config=loadConfig();}catch(error){log.error('initialization.configuration_failed',{failure:safeError(error)});process.exit(1);}
const pools=createPools(config);
const app=createApp({config,pools});
const server=app.listen(config.port,'0.0.0.0',()=>log.info('initialization.service.listening',{port:config.port,...runtimeIdentity,applications:['dockflow','power-tool']}));
server.on('error',error=>{log.error('initialization.service.failed',{failure:safeError(error)});process.exit(1);});
for(const [name,pool] of Object.entries(pools)) ping(pool).then(()=>reportConnectionState(name,true)).catch(error=>reportConnectionState(name,false,{failure:safeError(error)}));
let closing=false;
function shutdown(signal){
  if(closing)return;closing=true;log.info('connection.service.closing',{signal});
  setTimeout(()=>{log.error('connection.service.shutdown_timeout');process.exit(1);},10000).unref();
  server.close(async()=>{await Promise.allSettled(Object.values(pools).map(pool=>pool.end()));process.exit(0);});
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));
