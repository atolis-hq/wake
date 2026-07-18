import type { EventEnvelope, WakeConfig } from '../domain/types.js';
import type { OutboundSink, UnkeyedEventEnvelope, WorkSource } from './contracts.js';

export interface NamedWorkSource extends WorkSource {
  source: string;
}

export interface NamedOutboundSink extends OutboundSink {
  sink: string;
}

export function createWorkSourceFanIn(sources: NamedWorkSource[]): WorkSource {
  return {
    async pollEvents(input): Promise<UnkeyedEventEnvelope[]> {
      const batches = await Promise.all(sources.map((source) => source.pollEvents(input)));
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
  return stage === 'done' || event.payload.sentinel === 'BLOCKED';
}

function subscriptionMatches(event: EventEnvelope, subscription: string): boolean {
  if (subscription === intentKind(event)) {
    return true;
  }

  return subscription === 'stage.terminal' && isTerminalStageIntent(event);
}

function sinkNameForResourceUri(resourceUri: string, fallback: string): string {
  const [provider, kind] = resourceUri.split(':');
  if (provider === undefined || kind === undefined) {
    return fallback;
  }
  return kind === 'pr' || kind === 'pr-review-thread' ? `${provider}-pr` : fallback;
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
      const resourceUri = event.sourceRefs.resourceUri;
      if (
        event.sourceEventType === 'wake.publish.intent.requested' &&
        sourceOrigin !== undefined
      ) {
        targetSinks.add(
          resourceUri === undefined ? sourceOrigin : sinkNameForResourceUri(resourceUri, sourceOrigin),
        );
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
