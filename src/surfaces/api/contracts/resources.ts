export interface ResourceItemResponse {
  readonly resourceId: string;
  readonly adapter: string;
  readonly kind: string;
  readonly locatorLabel: string;
  readonly title?: string;
  readonly externalUrl?: string;
  readonly capabilities: readonly string[];
  readonly revision?: string;
}
