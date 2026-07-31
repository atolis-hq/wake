export interface ResourceItemResponse {
  readonly resourceId: string;
  readonly kind: string;
  readonly capabilities: readonly string[];
  readonly revision?: string;
}
