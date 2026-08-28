import { defineClosedVocabulary } from '../../kernel/index.js';

export const ConversationOriginKind = defineClosedVocabulary({
  ControlPlane: 'control-plane',
  Agent: 'agent',
  External: 'external',
} as const);
