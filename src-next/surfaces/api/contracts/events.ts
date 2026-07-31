export interface AuditEventResponse {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly position: number;
  readonly stream?: { readonly kind: string; readonly id: string };
  readonly causationId?: string;
  readonly correlationId?: string;
}
