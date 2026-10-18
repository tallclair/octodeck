/** Classic variant: composer insertion adapter. */
import type { ComposerAdapter } from '../types';

// The classic Comment button sits alone in a small wrapper; our control goes right before it.
export const classicComposerAdapter: ComposerAdapter = {
  insertionPoint: (submit) => ({ before: submit }),
};
