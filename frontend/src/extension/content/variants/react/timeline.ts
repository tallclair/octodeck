/** React issue-viewer variant: timeline adapter (per-element reads inside resolved timeline items). */
import { kindFromGid } from '../../capabilities/timelineKinds';
import type { TimelineAuthor } from '../../capabilities/types';
import type { TimelineAdapter } from '../types';
import { collectAnchors, firstIn, hasAdjacentBotLabel, isAppLink, kindFromOcticon, loginFromLink, parseDatetime } from '../shared';
import { REACT_ANCHORS } from './anchors';

const NODE_ID_ATTR = 'data-wrapper-timeline-id';
// fragile: Primer's timeline badge has only hashed classes, so the badge is located structurally as
// the row's first child. Used only as a fallback when the row's GID prefix is unmapped.
const ROW_BADGE_ICON = ':scope > div:first-child svg.octicon';

export const reactTimelineAdapter: TimelineAdapter = {
  itemNodeId: (item) => item.getAttribute(NODE_ID_ATTR),

  // Every React timeline <li> is one entry with one row.
  rows: (item) => [item],

  rowKind: (row) => {
    const host = row.hasAttribute(NODE_ID_ATTR) ? row : row.closest(`[${NODE_ID_ATTR}]`);
    const kind = kindFromGid(host?.getAttribute(NODE_ID_ATTR));
    if (kind && kind !== 'unknown') return { kind, source: 'gid' };
    const structural = kindFromOcticon(row.querySelector(ROW_BADGE_ICON));
    return structural ? { kind: structural, source: 'structure' } : null;
  },

  anchors: (el) => collectAnchors(el),

  author: (item): TimelineAuthor | null => {
    const link = firstIn(item, REACT_ANCHORS['timeline.itemAuthor']);
    if (!link) return null;
    const login = loginFromLink(link);
    if (!login) return null;
    return { login, isBotHint: hasAdjacentBotLabel(link), isApp: isAppLink(link) };
  },

  timestamp: (el) => parseDatetime(firstIn(el, REACT_ANCHORS['timeline.itemTime'])?.getAttribute('datetime')),

  body: (el) => firstIn(el, REACT_ANCHORS['timeline.itemBody']),
};
