/** React issue-viewer variant: scope detectors (section 4.2). */
import type { ScopeId, VariantDetector } from '../../dom/types';
import { REACT_ANCHORS, REACT_ISSUE_VIEWER_SELECTOR } from './anchors';

export const REACT_DETECTORS: Partial<Record<ScopeId, VariantDetector>> = {
  // Page scope: identity via the react-app embedded payload. Exclusive with the classic page
  // detector through the issue-viewer marker.
  page: {
    variant: 'react',
    root: { selectors: ['html'], validate: (el) => el.querySelector(REACT_ISSUE_VIEWER_SELECTOR) !== null },
  },
  timeline: { variant: 'react', root: REACT_ANCHORS['timeline.root'] },
  sidebar: { variant: 'react', root: REACT_ANCHORS['sidebar.root'] },
  composer: { variant: 'react', root: REACT_ANCHORS['composer.root'] },
};
