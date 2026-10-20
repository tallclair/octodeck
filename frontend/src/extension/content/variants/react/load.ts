/**
 * React issue-viewer timeline loading adapter
 * (docs/internal/extension_dom_engine_design.md sections 9.1, 9.2 and 9.4).
 *
 * GitHub's React issue viewer renders a "Load more" control in the middle of long timelines, but
 * its markup and completion signals have not been observed yet (the captured fixture has 11 items
 * and no pagination). Until a large-issue capture verifies them, this adapter fails closed:
 * load-more is reported as unsupported and never guessed, there is no timeline.loadMoreControl
 * locator, and no controlInsertionPoint, so the inline "Load all" control never renders here.
 * Revealing `<details>` around a target is generic and supported.
 */
import type { TimelineLoadAdapter } from '../types';
import { openCollapsedAncestors } from '../classic/load';

export const reactLoadAdapter: TimelineLoadAdapter = {
  supportsLoadMore: () => false,
  hidden: () => [],
  loadOne: async () => 'failed',
  async reveal(target, { signal }) {
    if (signal.aborted || !(target instanceof Element)) return false;
    openCollapsedAncestors(target);
    return true;
  },
};
