export type ValueOf<Catalogue extends Readonly<Record<string, unknown>>> =
  Catalogue[keyof Catalogue];

export const defineClosedVocabulary = <const Catalogue extends Readonly<Record<string, string>>>(
  catalogue: Catalogue,
): Catalogue => catalogue;

// How a configured list of required values is matched against observed values.
export const MatchMode = defineClosedVocabulary({
  Any: 'any',
  All: 'all',
} as const);

export type MatchMode = ValueOf<typeof MatchMode>;
