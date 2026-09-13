export function validateFreeCatalog(catalog: unknown): {
  freeGroups: string[];
  groupCount: number;
  iconCount: number;
};

export function assertCatalogMatchesDescriptor(
  catalog: unknown,
  descriptor: unknown,
): boolean;
