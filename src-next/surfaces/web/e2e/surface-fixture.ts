import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BuiltInActivityName } from '../../../activities/index.js';
import { RunStatus } from '../../../execution/index.js';
import { WorkStatus } from '../../../work/index.js';
import { createApiHttpServer, type ApiDispatcher } from '../../api/http-server.js';
import {
  ApiCommandStatus,
  toWorkItemKey,
  type AuditEventResponse,
  type WorkItemResponse,
} from '../../api/contracts/index.js';
import { createApiDispatcher, type ApiApplications } from '../../api/routes/index.js';
import { PackagedAssets } from '../../web-host/packaged-assets.js';

const instant = '2026-07-31T10:00:00.000Z';
const workItemKey = toWorkItemKey('work-demo');
const assetsRoot = resolve(process.cwd(), '../../../dist-next/src-next/surfaces/web-assets');

interface FixtureState {
  advanced: boolean;
  eventsRead: number;
  runnersRead: number;
  events: AuditEventResponse[];
}

let state = freshState();

const applications: ApiApplications = {
  now: () => instant,
  controlPlane: {
    status: async () => ({
      data: {
        paused: false,
        updatedAt: instant,
        ...(state.advanced ? { reason: 'Advanced one item' } : {}),
      },
      meta: { asOf: instant },
    }),
    async advance(command) {
      await delay(450);
      if (state.advanced)
        return {
          conflict: true,
          code: 'already-advanced',
          detail: 'Nothing is currently eligible to advance',
          current: { paused: false },
        };
      state.advanced = true;
      state.events.push(event(2, 'control-plane.advanced'));
      return {
        commandId: 'advance-1',
        idempotencyKey: command.idempotencyKey,
        acceptedAt: instant,
        status: ApiCommandStatus.Accepted,
        result: {
          data: {
            paused: false,
            updatedAt: instant,
            reason: 'Advanced one item',
          },
          meta: { asOf: instant },
        },
      };
    },
  },
  work: {
    async list() {
      return { items: [workSummary()], meta: { asOf: instant }, total: 1 };
    },
    async detail(key) {
      if (key !== workItemKey) return undefined;
      return {
        data: {
          work: workSummary(),
          resources: [],
          orchestration: { primary: null, children: [] },
          execution: { runs: [] },
          activities: {},
        },
        meta: { asOf: instant },
      };
    },
  },
  resources: { list: async () => ({ items: [], meta: { asOf: instant }, total: 0 }) },
  orchestration: { list: async () => ({ items: [], meta: { asOf: instant }, total: 0 }) },
  execution: {
    list: async () => ({ items: [run()], meta: { asOf: instant }, total: 1 }),
    get: async (runId) =>
      runId === 'run-1' ? { data: run(), meta: { asOf: instant } } : undefined,
    async runners() {
      state.runnersRead += 1;
      const available = state.runnersRead > 1;
      return {
        items: [
          {
            runnerId: 'runner-local',
            status: available ? 'available' : 'refreshing',
            available,
            updatedAt: instant,
          },
        ],
        meta: { asOf: instant },
        total: 1,
      };
    },
  },
  events: {
    async list(query) {
      state.eventsRead += 1;
      if (state.eventsRead === 2 && !state.events.some((item) => item.id === 'event-3'))
        state.events.push(event(3, 'runner.refreshed'));
      const after = query.cursor?.position ?? 0;
      const items = state.events.filter((item) => item.position > after).slice(0, query.limit);
      return {
        items,
        continuationPosition: items.at(-1)?.position ?? after,
        meta: {
          asOf: items.at(-1)?.occurredAt ?? instant,
          ...(items.at(-1)?.position === undefined ? {} : { position: items.at(-1)!.position }),
        },
      };
    },
  },
  observability: {
    metrics: async () => ({
      data: { collectedAt: instant, values: { events: state.events.length } },
      meta: { asOf: instant },
    }),
  },
  system: {
    health: async () => ({
      data: {
        status: 'ok',
        checkedAt: instant,
        checks: [{ name: 'journal', status: 'ok' }],
      },
      meta: { asOf: instant },
    }),
    configuration: async () => ({
      data: {
        configuration: { surfaces: { api: { host: '127.0.0.1' } }, secret: '[redacted]' },
      },
      meta: { asOf: instant },
    }),
  },
};

const production = createApiDispatcher(applications);
const dispatcher: ApiDispatcher = {
  async dispatch(method, target, body) {
    if (method === 'POST' && target === '/__wake-e2e/reset') {
      state = freshState();
      return { status: 200, body: { reset: true } };
    }
    return production.dispatch(method, target, body);
  },
};

const assets = new PackagedAssets(async (path) => {
  try {
    return await readFile(resolve(assetsRoot, path));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(error);
  }
});
const server = createApiHttpServer(dispatcher, assets);
server.listen(4319, '127.0.0.1');

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());

function freshState(): FixtureState {
  return { advanced: false, eventsRead: 0, runnersRead: 0, events: [event(1, 'work.created')] };
}
function workSummary(): WorkItemResponse {
  return {
    workItemKey,
    workItemId: 'work-demo',
    objective: state.advanced ? 'Demo Wake advanced' : 'Demo Wake',
    state: state.advanced ? WorkStatus.Closed : WorkStatus.Open,
    relatedWorkItems: [],
  };
}
function event(position: number, type: string): AuditEventResponse {
  return { id: `event-${position}`, type, occurredAt: instant, position };
}
function run() {
  return {
    runId: 'run-1',
    activationId: 'activation-1',
    activity: BuiltInActivityName.Agent,
    workflowInstanceId: 'workflow-1',
    orchestrationGroupId: 'group-1',
    attempt: 1,
    status: RunStatus.Succeeded,
    active: false,
    startedAt: instant,
    finishedAt: instant,
  };
}
function delay(milliseconds: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
