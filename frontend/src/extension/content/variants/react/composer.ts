/** React issue-viewer variant: composer insertion adapter. */
import type { ComposerAdapter } from '../types';

/**
 * Editors the expanded composer renders. GitHub's compact composer (a one-line button that expands
 * on click, seen on PR pages since 2026-10) and a not-yet-rendered composer body contain neither.
 */
const EDITOR_SELECTOR = 'textarea, [contenteditable="true"], [contenteditable=""]';

export const reactComposerAdapter: ComposerAdapter = {
  // The Comment button sits next to the close-issue ButtonGroup. If GitHub ever moves the Comment
  // button inside a Primer ButtonGroup, go before the whole group so its joined styling stays intact.
  insertionPoint: (submit) => ({ before: submit.closest('[data-component="ButtonGroup"]') ?? submit }),
  // Provisional (from drift-record fingerprints, 2026-10-21): confirm against captures of the
  // collapsed and expanded composer.
  collapsed: (root) => root.querySelector(EDITOR_SELECTOR) === null,
};
