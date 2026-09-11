import { describe, expect, it } from 'vitest';

import { adminModules, assignableGrants } from './modules';

describe('installed module catalogue', () => {
  it('removes retired and newly owner-only grants when editing an existing administrator', () => {
    const catalogue = [
      { id: 'billing', admin: { icon: 'credit-card', title: 'Payments' } },
      { id: 'operations', admin: { icon: 'app-window', title: 'Operations', assignable: false } },
    ];
    const stored = ['billing', 'retired-module', 'operations'];

    expect(assignableGrants(stored, catalogue)).toEqual(['billing']);
    expect(stored).toEqual(['billing', 'retired-module', 'operations']);
    expect(adminModules(catalogue)[0]).toEqual({
      id: 'billing', label: 'Payments', icon: 'credit-card', assignable: true,
      embedHref: '/admin/embed/module/billing/',
    });
  });

  it('keeps a module navigable if its icon is unavailable', () => {
    const [module] = adminModules([{ id: 'billing', admin: { title: 'Payments', icon: 'not-an-installed-icon' } }]);
    expect(module).toMatchObject({ id: 'billing', icon: 'app-window' });
  });
});
