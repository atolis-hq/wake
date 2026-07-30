export interface ExecutionConfig {
  readonly tiers: Readonly<Record<string, readonly string[]>>;
  readonly defaultTier: string;
}
