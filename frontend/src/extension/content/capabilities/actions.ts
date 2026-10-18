/** actions capability: classifies user events on GitHub's UI (read-only; section 6.5). */
import { isOwnNode } from '../engine/constants';
import type { VariantModule } from '../variants/types';
import type { ActionsCap } from './types';

/**
 * Delegates to the page variant's action adapter (WP2). Events that pass through any OctoDeck node
 * (our own buttons, checkboxes, notes editor) are never GitHub actions.
 */
export function createActionsCap(module: VariantModule | undefined): ActionsCap {
  return {
    classify: (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (path.some((n) => n instanceof Node && isOwnNode(n))) return null;
      if (path.length === 0 && event.target instanceof Node && isOwnNode(event.target)) return null;
      return module?.adapters.actions?.classify(event) ?? null;
    },
  };
}
