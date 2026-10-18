/** React issue-viewer variant: page adapter (identity and page flags). */
import type { PageAdapter } from '../types';
import { allEqualValue, metaContent } from '../shared';
import { REACT_ANCHORS } from './anchors';

export const reactPageAdapter: PageAdapter = {
  identity: (doc) => allEqualValue(doc, REACT_ANCHORS['page.identity']),
  repoNwo: (doc) => metaContent(doc.querySelector(REACT_ANCHORS['page.repo'].selectors[0])),
  // Not observed in fixtures yet (needs a locked / archived capture): unknown rather than guessed.
  locked: () => null,
  archived: () => null,
};
