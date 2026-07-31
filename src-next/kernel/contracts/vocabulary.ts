export type ValueOf<Catalogue extends Readonly<Record<string, unknown>>> =
  Catalogue[keyof Catalogue];

export const defineClosedVocabulary = <const Catalogue extends Readonly<Record<string, string>>>(
  catalogue: Catalogue,
): Catalogue => catalogue;
