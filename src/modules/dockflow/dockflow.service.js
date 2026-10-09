import { createSapRepository } from './dockflow.repository.js';
export function createDockflowService(settings) {
  const repositories = Object.fromEntries(['DRESSINGS','SAVOURY'].map(area => [area,createSapRepository(area,settings)]));
  return { repositories, execute(area,operation,args) { return repositories[area][operation](...args); },
    async health() {
      const areas = {};
      for (const [area,repo] of Object.entries(repositories)) {
        try { const page=await repo.page(0,1); areas[area]={ok:true,...page.source,columns:page.columns.map(column=>column[3]),hasRecords:page.rows.length>0}; }
        catch(error) { areas[area]={ok:false,code:String(error.code||''),error:'Receiving Records database is unavailable'}; }
      }
      return {ok:Object.values(areas).every(area=>area.ok),areas};
    },
  };
}
