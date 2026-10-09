import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

// The hand-written OpenAPI document is the source of truth for the API contract.
// test/openapi/ checks it against the real routes and responses so the two can't drift.
export const SPEC_URL = new URL('./openapi.yaml', import.meta.url);

// Returns the YAML text (served verbatim) and the parsed document (served as JSON).
export function loadSpec() {
  const yaml = readFileSync(SPEC_URL, 'utf8');
  return { yaml, document: parse(yaml) };
}
