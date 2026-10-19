export interface PackageSetCatalogInput {
  bindings: Record<string, unknown>;
  apiBaseUrl?: string;
  proToken?: string;
  fetcher?: typeof fetch;
}
export function fetchPackageSetCatalog(input: PackageSetCatalogInput): Promise<Record<string, unknown>>;
