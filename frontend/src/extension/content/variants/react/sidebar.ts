/** React issue-viewer variant: sidebar insertion adapter. */
import type { SidebarAdapter } from '../types';

// Our section goes directly above the first sidebar section (Assignees).
export const reactSidebarAdapter: SidebarAdapter = {
  insertionPoint: (anchor) => ({ before: anchor }),
};
