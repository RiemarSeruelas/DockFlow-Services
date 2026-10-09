// Shared query-string validation helpers. Each pushes a message onto `errors`
// instead of throwing, so a request can report every problem at once.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

// True only for real calendar dates in YYYY-MM-DD form (rejects 2026-02-30).
export function isCalendarDate(value) {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// Validates a plant-local timestamp without applying a timezone conversion.
// Both a space and "T" are accepted so URL clients can use either form.
export function isLocalDateTime(value) {
  const m = LOCAL_DATE_TIME_RE.exec(value);
  if (!m) return false;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const [hour, minute, second] = [Number(m[4]), Number(m[5]), Number(m[6])];
  return (
    isCalendarDate(date) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
}

export function normalizeLocalDateTime(value) {
  return value.replace('T', ' ');
}

// Reads a param that may appear at most once (?a=1&a=2 arrives as an array).
export function readSingle(query, name, errors) {
  const v = query[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    errors.push(`${name} must be given once`);
    return undefined;
  }
  return v;
}

export function parseIntParam(raw, name, { min, max, fallback }, errors) {
  if (raw === undefined || raw === '') return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    errors.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return n;
}
