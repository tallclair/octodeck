/** sidebar capability: where the OctoDeck sidebar section goes (section 6.3). */
import type { Resolver } from '../dom/resolver';
import type { VariantModule } from '../variants/types';
import type { SidebarCap } from './types';

export function createSidebarCap(resolver: Resolver, module: VariantModule): SidebarCap {
  return {
    insertionPoint: () => {
      const anchor = resolver.first('sidebar.insertBefore');
      if (!anchor) return null;
      return module.adapters.sidebar ? module.adapters.sidebar.insertionPoint(anchor) : { before: anchor };
    },
  };
}
