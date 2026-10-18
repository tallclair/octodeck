/** Classic variant: sidebar insertion adapter. */
import type { SidebarAdapter } from '../types';

// Insert before #partial-discussion-sidebar, outside the subtree GitHub replaces via AJAX.
export const classicSidebarAdapter: SidebarAdapter = {
  insertionPoint: (anchor) => ({ before: anchor }),
};
