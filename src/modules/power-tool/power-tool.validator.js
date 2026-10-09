const COLLECTIONS=['categories','legacyCategories','staffAccounts','requests','items'];
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
export function validatePowerToolOperation(operation,body) {
  if(operation==='read') return {value:{}};
  if(operation==='write') {
    if(!object(body?.before)||!object(body?.after)) return {errors:['before and after are required state objects']};
    for(const state of [body.before,body.after]) {
      if(!object(state.meta)||!object(state.usage)||COLLECTIONS.some(key=>!Array.isArray(state[key]))) return {errors:['Both snapshots must include meta, usage and all five collections']};
      for(const key of COLLECTIONS) {
        const ids=state[key].map(row=>row?.id);
        if(ids.some(id=>typeof id!=='string'||!id||id.length>200)||new Set(ids).size!==ids.length) return {errors:['Collection record IDs must be unique nonempty strings']};
      }
    }
    return {value:body};
  }
  if(operation==='log'&&object(body?.entry)&&typeof body.entry.eventType==='string'&&body.entry.eventType&&typeof body.entry.eventKey==='string'&&body.entry.eventKey) return {value:body};
  return {errors:['Invalid Power Tool operation or log entry']};
}
