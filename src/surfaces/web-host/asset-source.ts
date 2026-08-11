export interface SurfaceAsset {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Replaceable asset adapter.  Its source belongs to the package, never the Wake home. */
export interface AssetSource {
  get(path: string): Promise<SurfaceAsset | undefined>;
}
