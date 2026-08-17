import type { ApiDispatcher } from '../http-server.js';
import type { ApiApplications } from './applications.js';
import { dispatchCommand } from './commands.js';
import { dispatchRead } from './read.js';
import { problem } from './responses.js';

export type {
  ApiApplications,
  ApiCollectionPage,
  ApiCommandRequest,
  ApiResourceResult,
  ApiRunResolutionRequest,
  ApiSystemApplications,
  CollectionQuery,
} from './applications.js';

export function createApiDispatcher(applications: ApiApplications): ApiDispatcher {
  return {
    async dispatch(method, target, body) {
      const url = new URL(target, 'http://wake.local');
      if (!url.pathname.startsWith('/api/')) return undefined;
      const response = await dispatchRead(applications, method, url);
      if (response !== undefined) return response;
      if (method === 'POST') return dispatchCommand(applications, url, body);
      return problem(404, 'Not Found', `No route for ${url.pathname}`);
    },
  };
}
