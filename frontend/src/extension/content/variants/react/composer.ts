/** React issue-viewer variant: composer insertion adapter. */
import type { ComposerAdapter } from '../types';

// The Comment button sits next to the close-issue ButtonGroup. If GitHub ever moves the Comment
// button inside a Primer ButtonGroup, go before the whole group so its joined styling stays intact.
export const reactComposerAdapter: ComposerAdapter = {
  insertionPoint: (submit) => ({ before: submit.closest('[data-component="ButtonGroup"]') ?? submit }),
};
