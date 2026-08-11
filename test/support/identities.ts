import { resourceId, type ResourceId } from '../../src/resources/index.js';
import { workItemId, type WorkItemId } from '../../src/work/index.js';

const substitutions: Readonly<Record<string, string>> = { i: '1', l: '1', o: '0', u: 'v' };
const used = new Map<string, string>();

function ulidLike(seed: string): string {
  const body = [...seed.toLowerCase()]
    .map((character) => substitutions[character] ?? character)
    .filter((character) => /[0-9a-hjkmnp-tv-z]/.test(character))
    .join('');
  if (body.length === 0 || body.length > 26) throw new Error(`Unusable identity seed: ${seed}`);
  const value = body.padStart(26, '0');
  const owner = used.get(value);
  if (owner !== undefined && owner !== seed)
    throw new Error(`Identity seeds ${owner} and ${seed} collide`);
  used.set(value, seed);
  return value;
}

export const workId = (seed: string): WorkItemId => workItemId(`work-${ulidLike(seed)}`);

export const resId = (seed: string): ResourceId => resourceId(`resource-${ulidLike(seed)}`);
