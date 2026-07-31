import { resolve } from 'node:path';
import { checkContractVocabulary, CONTRACT_VOCABULARY_RULES } from './lib/contract-vocabulary.mjs';

const rules = parseRules(process.argv.slice(2));
const diagnostics = await checkContractVocabulary(resolve('src-next'), { rules });

if (diagnostics.length > 0) {
  process.stderr.write(`${diagnostics.map(({ message }) => message).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Contract vocabulary valid\n');
}

function parseRules(arguments_) {
  if (arguments_.length === 0) return undefined;
  let value;
  if (arguments_.length === 1 && arguments_[0].startsWith('--rules=')) {
    value = arguments_[0].slice('--rules='.length);
  } else if (arguments_.length === 2 && arguments_[0] === '--rules') {
    value = arguments_[1];
  } else {
    throw new Error('Usage: node scripts/check-contract-vocabulary.mjs [--rules rule,rule]');
  }
  const requested = value.split(',').filter(Boolean);
  const unknown = requested.filter((rule) => !CONTRACT_VOCABULARY_RULES.includes(rule));
  if (unknown.length > 0) {
    throw new Error(`Unknown contract-vocabulary rule: ${unknown.join(', ')}`);
  }
  return requested;
}
