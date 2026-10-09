// Express 4 ignores rejected promises from async handlers; forward them to the
// error handler so controllers don't each need try/catch.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
