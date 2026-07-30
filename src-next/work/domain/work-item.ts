import type { EventEnvelope } from '../../kernel/index.js';
import { workItemId } from '../contracts/identifiers.js';
import type { WorkItemView, WorkState } from '../contracts/views.js';

type WorkItemEvent = EventEnvelope<string, unknown>;

export function foldWorkItem(events: readonly WorkItemEvent[]): WorkItemView | null {
  if (events.length === 0) return null;
  if (events[0]?.eventType !== 'work.item-created') {
    throw new Error('WorkItem stream must begin with work.item-created');
  }

  const id = workItemId(events[0].stream.id);
  const objective = objectiveFrom(events[0].payload);
  const state = {
    objective,
    lifecycle: 'open' as WorkState,
    links: [] as WorkItemView['relatedWorkItems'][number][],
    linkKeys: new Set<string>(),
  };
  for (const [index, event] of events.entries()) applyEvent(state, event, index, id);

  return {
    workItemId: id,
    objective: state.objective,
    state: state.lifecycle,
    relatedWorkItems: state.links,
  };
}

function applyEvent(
  state: {
    objective: string;
    lifecycle: WorkState;
    links: WorkItemView['relatedWorkItems'][number][];
    linkKeys: Set<string>;
  },
  event: WorkItemEvent,
  index: number,
  id: string,
): void {
  assertWorkStream(event, index, id);
  if (event.eventType === 'work.objective-revised') state.objective = objectiveFrom(event.payload);
  if (event.eventType === 'work.item-closed') state.lifecycle = 'closed';
  if (event.eventType === 'work.item-cancelled') state.lifecycle = 'cancelled';
  if (event.eventType === 'work.item-linked') addLink(state, linkFrom(event.payload));
}

function assertWorkStream(event: WorkItemEvent, index: number, id: string): void {
  if (event.stream.kind !== 'work-item' || event.stream.id !== id) {
    throw new Error('WorkItem events must belong to the same work-item stream');
  }
  if (index > 0 && event.eventType === 'work.item-created') {
    throw new Error('WorkItem stream cannot contain a second creation event');
  }
}

function addLink(
  state: { links: WorkItemView['relatedWorkItems'][number][]; linkKeys: Set<string> },
  link: WorkItemView['relatedWorkItems'][number],
): void {
  const key = `${link.workItemId}:${link.relation}`;
  if (!state.linkKeys.has(key)) {
    state.linkKeys.add(key);
    state.links.push(link);
  }
}

function objectiveFrom(payload: unknown): string {
  if (
    !isRecord(payload) ||
    typeof payload.objective !== 'string' ||
    payload.objective.trim().length === 0
  ) {
    throw new Error('WorkItem objective must not be empty');
  }
  return payload.objective;
}

function linkFrom(payload: unknown): WorkItemView['relatedWorkItems'][number] {
  if (!isRecord(payload) || typeof payload.to !== 'string' || !isRelation(payload.relation)) {
    throw new Error('Invalid WorkItem link event');
  }
  return { workItemId: workItemId(payload.to), relation: payload.relation };
}

function isRelation(value: unknown): value is WorkItemView['relatedWorkItems'][number]['relation'] {
  return value === 'relates-to' || value === 'parent-of' || value === 'child-of';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
