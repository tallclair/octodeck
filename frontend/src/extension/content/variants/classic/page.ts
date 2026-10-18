/** Classic variant: page adapter (identity and page flags). */
import type { PageAdapter } from '../types';
import { allEqualValue, metaContent } from '../shared';
import { CLASSIC_ANCHORS } from './anchors';

export const classicPageAdapter: PageAdapter = {
  identity: (doc) => allEqualValue(doc, CLASSIC_ANCHORS['page.identity']),
  repoNwo: (doc) => metaContent(doc.querySelector(CLASSIC_ANCHORS['page.repo'].selectors[0])),
  // Not observed in fixtures yet (needs a locked / archived capture): unknown rather than guessed.
  locked: () => null,
  archived: () => null,
};
