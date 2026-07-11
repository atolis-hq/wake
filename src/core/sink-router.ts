import type { EventEnvelope, WakeConfig } from '../domain/types.js';
import type { OutboundSink, WorkSource } from './contracts.js';

export interface NamedWorkSource extends WorkSource {
  source: string;
}

export interface NamedOutboundSink extends OutboundSink {
  sink: string;
}

export function createWorkSourceFanIn(sources: NamedWorkSource[]): WorkSource {
  return {
    async pollEvents(): Promise<EventEnvelope[]> {
      const batches = await Promise.all(sources.map((source) => source.pollEvents()));
      return batches.flat();
    },
  };
}

function intentKind(event: EventEnvelope): string | null {
  if (event.sourceEventType !== 'wake.publish.intent.requested') {
    return null;
  }

  return typeof event.payload.kind === 'string' ? event.payload.kind : null;
}

function isTerminalStageIntent(event: EventEnvelope): boolean {
  const stage = event.derivedHints?.stage;
  return stage === 'done' || stage === 'blocked';
}

function subscriptionMatches(event: EventEnvelope, subscription: string): boolean {
  if (subscription === intentKind(event)) {
    return true;
  }

  return subscription === 'stage.terminal' && isTerminalStageIntent(event);
}

function withSinkRef(event: EventEnvelope, sink: string): EventEnvelope {
  return {
    ...event,
    sourceRefs: {
      ...event.sourceRefs,
      sink: event.sourceRefs.sink ?? sink,
    },
  };
}

export function createOutboundSinkRouter(input: {
  sinks: NamedOutboundSink[];
  config: WakeConfig;
}): OutboundSink {
  const sinksByName = new Map(input.sinks.map((sink) => [sink.sink, sink]));

  return {
    async deliverIntent({ event }: { event: EventEnvelope }): Promise<EventEnvelope[]> {
      const targetSinks = new Set<string>();
      const origin = typeof event.payload.origin === 'string' ? event.payload.origin : undefined;
      const sourceOrigin = event.sourceRefs.sink ?? origin;

      if (event.sourceEventType === 'wake.labels.requested') {
        const projectionOrigin = typeof event.payload.origin === 'string'
          ? event.payload.origin
          : undefined;
        if (projectionOrigin !== undefined) {
          targetSinks.add(projectionOrigin);
        }
      }

      const kind = intentKind(event);
      if (
        event.sourceEventType === 'wake.publish.intent.requested' &&
        sourceOrigin !== undefined
      ) {
        targetSinks.add(sourceOrigin);
      }

      for (const [sinkName, sinkConfig] of Object.entries(input.config.sinks ?? {})) {
        if (sinkConfig.subscribe.some((subscription) => subscriptionMatches(event, subscription))) {
          targetSinks.add(sinkName);
        }
      }

      const deliveryEvents: EventEnvelope[] = [];
      for (const sinkName of targetSinks) {
        const sink = sinksByName.get(sinkName);
        if (sink === undefined) {
          continue;
        }

        const sinkDeliveryEvents = await sink.deliverIntent({ event });
        deliveryEvents.push(
          ...sinkDeliveryEvents.map((deliveryEvent) => withSinkRef(deliveryEvent, sinkName)),
        );
      }

      return deliveryEvents;
    },
  };
}
