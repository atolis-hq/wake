export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export interface EntityRef<Kind extends string = string, Id extends string = string> {
  readonly kind: Kind;
  readonly id: Id;
}
