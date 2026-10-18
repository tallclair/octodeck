import { describe, it, expect } from 'vitest';
import {
  buildCollapseSummaryText,
  calculateTimelineMarkerIndices,
  classifyNoise,
  computeCollapseRuns,
  extractFirstNonBlankLine,
  extractRemainingLines,
  hideSanityAnomaly,
  isBotLogin,
  isCommentMultiLine,
  isRowHideable,
  isSlashCommandBody,
  type NoiseInput,
  type RunInput,
} from '../timelineClassify';

describe('isBotLogin', () => {
  it('matches bot suffixes and known bots, case-insensitively', () => {
    expect(isBotLogin('dependabot[bot]')).toBe(true);
    expect(isBotLogin('k8s-ci-robot')).toBe(true);
    expect(isBotLogin('my_bot')).toBe(true);
    expect(isBotLogin('Prow', ['prow'])).toBe(true);
    expect(isBotLogin('codecov', ['codecov[bot]'])).toBe(true);
  });

  it('does not match humans or words containing "bot"', () => {
    expect(isBotLogin('alice')).toBe(false);
    expect(isBotLogin('abbott')).toBe(false);
    expect(isBotLogin('robotics-fan')).toBe(false);
    expect(isBotLogin('')).toBe(false);
  });
});

describe('isSlashCommandBody', () => {
  it('requires every non-blank line to be a command', () => {
    expect(isSlashCommandBody('/lgtm')).toBe(true);
    expect(isSlashCommandBody('/approve\n\n/hold cancel')).toBe(true);
    expect(isSlashCommandBody('/lgtm\nthanks!')).toBe(false);
    expect(isSlashCommandBody('see /docs')).toBe(false);
    expect(isSlashCommandBody('')).toBe(false);
  });
});

describe('text helpers', () => {
  it('split the first line from the rest', () => {
    expect(extractFirstNonBlankLine('\n  first\nsecond')).toBe('first');
    expect(extractRemainingLines('\nfirst\nsecond\nthird\n')).toBe('second\nthird');
    expect(isCommentMultiLine('one\n\n')).toBe(false);
    expect(isCommentMultiLine('one\ntwo')).toBe(true);
  });

  it('builds collapse summaries', () => {
    expect(buildCollapseSummaryText(2, 1, ['a', 'b'])).toBe('2 comments and 1 other event from @a, @b');
    expect(buildCollapseSummaryText(1, 0, [])).toBe('1 comment');
    expect(buildCollapseSummaryText(0, 3, [])).toBe('3 other events');
    expect(buildCollapseSummaryText(0, 0, [])).toBe('activity');
  });
});

describe('isRowHideable (decision 11 allowlist)', () => {
  it('hides only bodiless allowlisted kinds', () => {
    expect(isRowHideable({ kind: 'event', hasBody: false })).toBe(true);
    expect(isRowHideable({ kind: 'commit', hasBody: false })).toBe(true);
    expect(isRowHideable({ kind: 'event', hasBody: true })).toBe(false);
  });

  it('never hides unknown, other events, close/reopen, references, reviews or comments', () => {
    for (const kind of ['unknown', 'otherEvent', 'closeReopen', 'reference', 'review', 'reviewThread', 'comment', 'description']) {
      expect(isRowHideable({ kind, hasBody: false })).toBe(false);
    }
  });
});

describe('classifyNoise', () => {
  const base: NoiseInput = { kind: 'comment', authorLogin: 'alice', isBotHint: false, isApp: false, bodyText: 'hello' };

  it('treats bot logins, bot badges and /apps/ authors as bots (decision 13)', () => {
    expect(classifyNoise({ ...base, authorLogin: 'k8s-ci-robot' }, [], null).isNoise).toBe(true);
    expect(classifyNoise({ ...base, isBotHint: true }, [], null).isNoise).toBe(true);
    expect(classifyNoise({ ...base, isApp: true }, [], null).isNoise).toBe(true);
    expect(classifyNoise({ ...base, authorLogin: 'prow' }, ['prow'], null).isNoise).toBe(true);
  });

  it('treats slash-command-only comments as noise', () => {
    expect(classifyNoise({ ...base, bodyText: '/lgtm' }, [], null)).toMatchObject({ isNoise: true, isSlashCommand: true });
  });

  it('never classifies the signed-in viewer as a bot', () => {
    const v = classifyNoise({ ...base, authorLogin: 'Me', isBotHint: true }, ['me'], 'me');
    expect(v.isBot).toBe(false);
    expect(v.isNoise).toBe(false);
  });

  it('never makes reviews noise, even from bots or with comments', () => {
    expect(classifyNoise({ ...base, kind: 'review', isApp: true }, [], null).isNoise).toBe(false);
    expect(classifyNoise({ ...base, kind: 'reviewThread', authorLogin: 'x[bot]' }, [], null).isNoise).toBe(false);
  });

  it('keeps human comments visible', () => {
    expect(classifyNoise(base, [], null).isNoise).toBe(false);
  });
});

describe('computeCollapseRuns', () => {
  const noise: RunInput = { isNoise: true, fullyHidden: false, kind: 'comment' };
  const human: RunInput = { isNoise: false, fullyHidden: false, kind: 'comment' };
  const hiddenEvent: RunInput = { isNoise: false, fullyHidden: true, kind: 'event' };
  const visibleEvent: RunInput = { isNoise: false, fullyHidden: false, kind: 'closeReopen' };

  it('groups only directly adjacent noise when events are shown', () => {
    expect(computeCollapseRuns([noise, noise, hiddenEvent, noise, human, noise], false)).toEqual([[0, 1], [3], [5]]);
  });

  it('lets hidden events join runs when events are hidden', () => {
    expect(computeCollapseRuns([noise, hiddenEvent, noise, visibleEvent, noise], true)).toEqual([[0, 2], [4]]);
  });

  it('never groups across the description', () => {
    expect(
      computeCollapseRuns([noise, { isNoise: false, fullyHidden: true, kind: 'description' }, noise], true)
    ).toEqual([[0], [2]]);
  });
});

describe('hideSanityAnomaly', () => {
  const ok = { kind: 'comment', hasBody: true };

  it('accepts legitimate pages with no comments or mostly hideable events (bot PRs)', () => {
    const items = [{ kind: 'description', hasBody: true }, ...Array(10).fill({ kind: 'event', hasBody: false })];
    const rows = items.map((i) => ({ ...i, kindSource: 'gid' }));
    expect(hideSanityAnomaly(items, rows)).toBeNull();
    expect(hideSanityAnomaly([ok], [{ ...ok, kindSource: 'gid' }])).toBeNull();
  });

  it('flags user content inside an unknown kind', () => {
    expect(hideSanityAnomaly([{ kind: 'unknown', hasBody: true }], [])).toMatch(/unknown/);
    expect(hideSanityAnomaly([ok], [{ kind: 'unknown', kindSource: 'structure', hasBody: true }])).toMatch(/unknown/);
    expect(hideSanityAnomaly([{ kind: 'unknown', hasBody: false }], [])).toBeNull();
  });

  it('flags a body inside an item kind that never has one', () => {
    expect(hideSanityAnomaly([{ kind: 'event', hasBody: true }], [])).toMatch(/'event'/);
    expect(hideSanityAnomaly([{ kind: 'reference', hasBody: true }], [])).toBeNull();
  });

  it('flags hideable rows classified by a text heuristic', () => {
    expect(hideSanityAnomaly([], [{ kind: 'event', kindSource: 'heuristic', hasBody: false }])).toMatch(/heuristic/);
    expect(hideSanityAnomaly([], [{ kind: 'closeReopen', kindSource: 'heuristic', hasBody: false }])).toBeNull();
  });
});

describe('calculateTimelineMarkerIndices', () => {
  const items = [{ timestamp: 1000 }, { timestamp: 2000 }, { timestamp: 3000 }, { timestamp: 4000 }];

  it('renders both Last Viewed and Acknowledged when at different positions', () => {
    const res = calculateTimelineMarkerIndices(items, 2500, 1500);
    expect(res.showAckIndex).toBe(1);
    expect(res.showViewIndex).toBe(2);
  });

  it('renders both when Last Viewed is earlier than Acknowledged', () => {
    const res = calculateTimelineMarkerIndices(items, 1500, 2500);
    expect(res.showViewIndex).toBe(1);
    expect(res.showAckIndex).toBe(2);
  });

  it('suppresses Last Viewed when both are at the exact same location', () => {
    const res = calculateTimelineMarkerIndices(items, 2500, 2500);
    expect(res.showAckIndex).toBe(2);
    expect(res.showViewIndex).toBe(-1);
  });

  it('suppresses markers when nothing is newer (at the end)', () => {
    expect(calculateTimelineMarkerIndices(items, 5000, 5000)).toEqual({ showViewIndex: -1, showAckIndex: -1 });
  });

  it('shows Last Viewed but not Acknowledged when Acked is at the end', () => {
    expect(calculateTimelineMarkerIndices(items, 2500, 5000)).toEqual({ showViewIndex: 2, showAckIndex: -1 });
  });

  it('shows Acknowledged but not Last Viewed when Last Viewed is at the end', () => {
    expect(calculateTimelineMarkerIndices(items, 5000, 1500)).toEqual({ showViewIndex: -1, showAckIndex: 1 });
  });

  it('handles null / unset timestamps gracefully', () => {
    expect(calculateTimelineMarkerIndices(items, 2500, null)).toEqual({ showViewIndex: 2, showAckIndex: -1 });
    expect(calculateTimelineMarkerIndices(items, null, 1500)).toEqual({ showViewIndex: -1, showAckIndex: 1 });
    expect(calculateTimelineMarkerIndices([], 2500, 1500)).toEqual({ showViewIndex: -1, showAckIndex: -1 });
  });

  it('suppresses Last Viewed when wasViewMarkerShown is false', () => {
    expect(calculateTimelineMarkerIndices(items, 2500, null, { wasViewMarkerShown: false }).showViewIndex).toBe(-1);
  });

  it('compares the ack watermark at second precision', () => {
    const wm = Date.parse('2026-08-12T15:00:00Z');
    const entries = [{ timestamp: wm - 60_000 }, { timestamp: wm + 345 }, { timestamp: wm + 1000 }];
    expect(calculateTimelineMarkerIndices(entries, null, wm).showAckIndex).toBe(2);
  });
});
