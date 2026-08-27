const wakeDeliveryMarkerPattern = /<!--\s*wake:delivery:([^\s>]+)\s*-->/;

export function deliveryMarker(body: string): string | undefined {
  return wakeDeliveryMarkerPattern.exec(body)?.[1];
}

export function appendDeliveryMarker(body: string, intentEventId: string): string {
  return `${body}\n<!-- wake:delivery:${intentEventId} -->`.trim();
}
