import { createPowerToolRepository } from './power-tool.repository.js';
export function createPowerToolService(settings) {
  const repository=createPowerToolRepository(settings);
  const initialized=repository.initializeDataStore();
  async function ready() {
    await initialized;
    if(repository.getDataStoreState().provider!=='postgresql') await repository.reconnectPostgres();
    return repository.checkDb();
  }
  return {repository,ready, async execute(operation,body) {
    await ready();
    return operation==='read'?repository.readDb():operation==='write'?repository.writeRemoteDb(body.after,body.before):repository.recordPowerToolLog(body.entry);
  }};
}
