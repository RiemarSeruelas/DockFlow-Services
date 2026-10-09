export const OPERATIONS = ['describe','sync','page','byKeys','all','forShipment','forClearance','add','save'];
export function validateOperation(area, operation, body) {
  if (!['DRESSINGS','SAVOURY'].includes(area) || !OPERATIONS.includes(operation)) return { errors:['Unknown receiving operation'] };
  if (!Array.isArray(body?.args) || body.args.length > 4) return { errors:['args must be an array with at most four entries'] };
  const args = body.args;
  if (['sync','save','byKeys'].includes(operation) && !Array.isArray(args[0])) return { errors:['The first argument must be an array'] };
  if (['add','forClearance'].includes(operation) && (!args[0] || typeof args[0] !== 'object' || Array.isArray(args[0]))) return { errors:['The first argument must be an object'] };
  return { value:args };
}
