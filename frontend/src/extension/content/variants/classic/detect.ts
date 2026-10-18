/** Classic variant: scope detectors (section 4.2). */
import type { ScopeId, VariantDetector } from '../../dom/types';
import { REACT_ISSUE_VIEWER_SELECTOR } from '../react/anchors';
import { CLASSIC_ANCHORS } from './anchors';

export const CLASSIC_DETECTORS: Partial<Record<ScopeId, VariantDetector>> = {
  // Page scope: identity via data-gid. Both the classic PR page and the React issue page run inside
  // GitHub's React shell, so this detector must exclude React issue-viewer pages explicitly.
  page: {
    variant: 'classic',
    root: { selectors: ['html'], validate: (el) => el.querySelector(REACT_ISSUE_VIEWER_SELECTOR) === null },
  },
  timeline: { variant: 'classic', root: CLASSIC_ANCHORS['timeline.root'] },
  sidebar: { variant: 'classic', root: CLASSIC_ANCHORS['sidebar.root'] },
  composer: { variant: 'classic', root: CLASSIC_ANCHORS['composer.root'] },
};
