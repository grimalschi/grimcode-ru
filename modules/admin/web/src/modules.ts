import { dynamicIconImports, type IconName } from 'lucide-react/dynamic';
import type { CatalogueEntry } from '../../src/vocabulary.js';

/** The server sends only modules this administrator may open. Paths follow one convention. */
export function adminModules(catalogue: readonly CatalogueEntry[]) {
  return catalogue.map(({ id, admin }) => ({
    id,
    label: admin.title,
    icon: (Object.hasOwn(dynamicIconImports, admin.icon) ? admin.icon : 'app-window') as IconName,
    assignable: admin.assignable !== false,
    embedHref: `/admin/embed/module/${id}/`,
  }));
}

/** Retired or newly owner-only modules must not leave hidden, unsaveable selections in the editor. */
export function assignableGrants(grants: readonly string[], catalogue: readonly CatalogueEntry[]): string[] {
  const allowed = new Set(catalogue.filter(({ admin }) => admin.assignable !== false).map(({ id }) => id));
  return grants.filter((id) => allowed.has(id));
}
