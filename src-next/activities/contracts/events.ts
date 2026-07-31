import type { ActivationId } from './identifiers.js';

export interface ActivityActivated {
  readonly activationId: ActivationId;
  readonly activity: string;
}
