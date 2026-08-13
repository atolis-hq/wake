import { MatchMode } from '../contracts/vocabulary.js';

// The mode governs matching within one list; an empty requirement constrains nothing,
// so callers AND separate lists together to express "this and that".
export function matchesRequiredValues(
  mode: MatchMode,
  required: readonly string[],
  observed: readonly string[],
): boolean {
  if (required.length === 0) return true;
  const present = new Set(observed);
  return mode === MatchMode.All
    ? required.every((value) => present.has(value))
    : required.some((value) => present.has(value));
}
