import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { projectMeasuredCounts } from './billing.mjs';
const [input] = process.argv.slice(2);
assert(input, 'Usage: price-tokens.mjs TOKEN_REPORT.json');
const report = JSON.parse(readFileSync(input, 'utf8'));
assert(Array.isArray(report.rows), 'Expected a measure-captures token report');
console.log(JSON.stringify({ sourceTokenUnits: report.tokenizer ?? 'caller-supplied token units',
  rateCard: 'Hypothetical GPT-6.1 Sol Responses rates; token counts and cache hits are not measured on Sol',
  exactBoundaryResidency: projectMeasuredCounts(report.rows, 'boundaries'),
  zeroReads: projectMeasuredCounts(report.rows, 'zero'),
}, null, 2));
