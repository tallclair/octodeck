/**
 * Classic (Rails) conversation variant: timeline, sidebar and composer rendered by GitHub's Rails
 * partials (seen inside the React shell on PR conversation pages).
 */
import type { VariantModule } from '../types';
import { CLASSIC_ANCHORS } from './anchors';
import { classicActionAdapter } from './actions';
import { classicComposerAdapter } from './composer';
import { CLASSIC_DETECTORS } from './detect';
import { classicLoadAdapter } from './load';
import { classicPageAdapter } from './page';
import { classicSidebarAdapter } from './sidebar';
import { classicTimelineAdapter } from './timeline';

export const classic: VariantModule = {
  id: 'classic',
  detectors: CLASSIC_DETECTORS,
  anchors: CLASSIC_ANCHORS,
  adapters: {
    page: classicPageAdapter,
    timeline: classicTimelineAdapter,
    // Loading and action classification are owned by WP2 (tracker).
    load: classicLoadAdapter,
    actions: classicActionAdapter,
    composer: classicComposerAdapter,
    sidebar: classicSidebarAdapter,
  },
};
