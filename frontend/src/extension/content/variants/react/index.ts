/** React issue-viewer variant: timeline, sidebar and composer rendered by GitHub's React issue viewer. */
import type { VariantModule } from '../types';
import { REACT_ANCHORS } from './anchors';
import { reactActionAdapter } from './actions';
import { reactComposerAdapter } from './composer';
import { REACT_DETECTORS } from './detect';
import { reactLoadAdapter } from './load';
import { reactPageAdapter } from './page';
import { reactSidebarAdapter } from './sidebar';
import { reactTimelineAdapter } from './timeline';

export const react: VariantModule = {
  id: 'react',
  detectors: REACT_DETECTORS,
  anchors: REACT_ANCHORS,
  adapters: {
    page: reactPageAdapter,
    timeline: reactTimelineAdapter,
    // Loading and action classification are owned by WP2 (tracker).
    load: reactLoadAdapter,
    actions: reactActionAdapter,
    composer: reactComposerAdapter,
    sidebar: reactSidebarAdapter,
  },
};
