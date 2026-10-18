/** Classic variant: timeline adapter (per-element reads inside resolved timeline items). */
import { kindFromGid } from '../../capabilities/timelineKinds';
import type { TimelineAuthor } from '../../capabilities/types';
import type { TimelineAdapter } from '../types';
import { collectAnchors, firstIn, hasAdjacentBotLabel, isAppLink, kindFromOcticon, loginFromLink, parseDatetime } from '../shared';
import { CLASSIC_ANCHORS } from './anchors';


/** The badge icon of a classic event row. */
const ROW_BADGE_ICON = '.TimelineItem-badge svg';
const ITEM_SELECTOR = CLASSIC_ANCHORS['timeline.item'].selectors[0];
const ROW_LOCATOR = CLASSIC_ANCHORS['timeline.row'];

function eventRows(item: Element): Element[] {
  return Array.from(item.querySelectorAll(ROW_LOCATOR.selectors[0])).filter((el) => !ROW_LOCATOR.validate || ROW_LOCATOR.validate(el));
}

export const classicTimelineAdapter: TimelineAdapter = {
  itemNodeId: (item) => item.getAttribute('data-gid'),

  // Grouped items hold one [id^=event-] row per event; everything else is a single row.
  rows: (item) => {
    const rows = eventRows(item);
    return rows.length > 0 ? rows : [item];
  },

  rowKind: (row) => {
    const item = row.matches(ITEM_SELECTOR) ? row : row.closest(ITEM_SELECTOR);
    // The item itself, or the only row of a single-event item: the node id names its type. An
    // unmapped prefix ('unknown') is no answer: fall through to the badge icon (the capability still
    // reports the unknown prefix so the GID table can grow).
    if (item && (row === item || eventRows(item).length === 1)) {
      const kind = kindFromGid(item.getAttribute('data-gid'));
      if (kind && kind !== 'unknown') return { kind, source: 'gid' };
    }
    const kind = kindFromOcticon(row.querySelector(ROW_BADGE_ICON));
    return kind ? { kind, source: 'structure' } : null;
  },

  anchors: (el) => collectAnchors(el),

  author: (item): TimelineAuthor | null => {
    const link = firstIn(item, CLASSIC_ANCHORS['timeline.itemAuthor']);
    if (!link) return null;
    const login = loginFromLink(link);
    if (!login) return null;
    return { login, isBotHint: hasAdjacentBotLabel(link), isApp: isAppLink(link) };
  },

  timestamp: (el) => parseDatetime(firstIn(el, CLASSIC_ANCHORS['timeline.itemTime'])?.getAttribute('datetime')),

  body: (el) => firstIn(el, CLASSIC_ANCHORS['timeline.itemBody']),
};
