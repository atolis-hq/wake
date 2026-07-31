import { createContext, useContext } from 'react';
import type { WakeApiClient } from './client.js';

export const ApiClientContext = createContext<WakeApiClient | null>(null);
export function useApiClient(): WakeApiClient {
  const client = useContext(ApiClientContext);
  if (client === null) throw new Error('WakeApiClient is not configured');
  return client;
}
