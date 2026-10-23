import { describe, expect, it } from 'vitest';
import {
  attachCounts,
  badgeScope,
  buildCountRequest,
  isActive,
  moveItem,
  reapplySavedSearchText,
  resolveSavedSearchBadge,
  stripTabClauses,
  suggestName,
  tabClauses,
  toView,
  validateSavedSearchName,
  type BadgeScope,
  type SavedSearchInput,
} from '../savedSearches';
import { parseQuery } from '../query/syntax';
import { SortKey, SortOrder as ProtoSortOrder } from '../../api/octodeck/v1/query_pb';

describe('savedSearches logic', () => {
  describe('toView', () => {
    it('creates a view for valid query text', () => {
      const input: SavedSearchInput = {
        id: 's1',
        name: 'My Search',
        query: 'repo:kubernetes/kubernetes is:open',
        sort: { key: SortKey.CREATED, order: ProtoSortOrder.ASC },
      };
      const view = toView(input);
      expect(view.id).toBe('s1');
      expect(view.name).toBe('My Search');
      expect(view.text).toBe('repo:kubernetes/kubernetes is:open');
      expect(view.error).toBeNull();
      expect(view.canonical).toBe('repo:kubernetes/kubernetes state:open');
      expect(view.sort).toBe('created');
      expect(view.order).toBe('asc');
      expect(view.hasScope).toBe(false);
      expect(view.scope).toBe('inbox');
      expect(view.count).toBeNull();
    });

    it('creates a view with error for invalid query text', () => {
      const input: SavedSearchInput = {
        id: 's2',
        name: 'Bad Search',
        query: 'state:bogus',
      };
      const view = toView(input);
      expect(view.id).toBe('s2');
      expect(view.error).not.toBeNull();
      expect(view.canonical).toBe('');
    });
  });

  describe('badgeScope (§6.3 table)', () => {
    const table: Array<[query: string, expected: BadgeScope]> = [
      ['repo:k/k', 'inbox'],
      ['triage:inbox label:bug', 'inbox'],
      ['new:mention repo:k/k', 'new'],
      ['is:new', 'new'],
      ['-triage:inbox', 'acked'],
      ['triage:acked new:any', 'acked'],
      ['triage:all', 'all'],
      ['is:inbox,acked', 'all'],
      ['-new:noise', 'inbox'],
      ['new:noise', 'inbox'],
      ['triage:inbox triage:acked', 'inbox'], // empty allowed defaults to inbox
    ];

    it.each(table)('classifies "%s" as %s', (query, expected) => {
      const parsed = parseQuery(query);
      expect(badgeScope(parsed)).toBe(expected);
    });
  });

  describe('tabClauses and stripTabClauses', () => {
    it('extracts triage clauses when present', () => {
      const parsed = parseQuery('triage:acked repo:k/k');
      const tabs = tabClauses(parsed);
      expect(tabs).toHaveLength(1);
      expect(tabs[0].raw).toBe('triage:acked');
      expect(stripTabClauses(parsed)).toBe('repo:k/k');
    });

    it('extracts first new:any clause only when no triage clause exists', () => {
      const parsed = parseQuery('new:any repo:k/k');
      const tabs = tabClauses(parsed);
      expect(tabs).toHaveLength(1);
      expect(tabs[0].raw).toBe('new:any');
      expect(stripTabClauses(parsed)).toBe('repo:k/k');
    });

    it('does not treat new:mention as tab clause', () => {
      const parsed = parseQuery('new:mention repo:k/k');
      expect(tabClauses(parsed)).toHaveLength(0);
      expect(stripTabClauses(parsed)).toBe('new:mention repo:k/k');
    });

    it('ignores new:any if triage clause is present', () => {
      const parsed = parseQuery('triage:acked new:any');
      const tabs = tabClauses(parsed);
      expect(tabs).toHaveLength(1);
      expect(tabs[0].raw).toBe('triage:acked');
    });
  });

  describe('buildCountRequest and attachCounts', () => {
    const valid1 = toView({ id: '1', name: 'V1', query: 'repo:a/b' });
    const invalid = toView({ id: '2', name: 'Bad', query: 'state:bogus' });
    const valid2 = toView({ id: '3', name: 'V2', query: 'repo:c/d' });

    it('skips invalid searches in buildCountRequest', () => {
      const req = buildCountRequest([valid1, invalid, valid2]);
      expect(req.queries).toHaveLength(2);
      expect(req.rowIndex).toEqual([0, 2]);
    });

    it('attaches counts back to rows by index', () => {
      const req = buildCountRequest([valid1, invalid, valid2]);
      const results = [
        { count: 10, newCount: 2, inboxCount: 8 },
        { count: 5, newCount: 0, inboxCount: 5 },
      ];
      const attached = attachCounts([valid1, invalid, valid2], req.rowIndex, results);
      expect(attached[0].count).toBe(10);
      expect(attached[0].newCount).toBe(2);
      expect(attached[0].inboxCount).toBe(8);

      expect(attached[1].count).toBeNull();
      expect(attached[1].error).not.toBeNull();

      expect(attached[2].count).toBe(5);
      expect(attached[2].newCount).toBe(0);
      expect(attached[2].inboxCount).toBe(5);
    });

    it('maps server count error to view error', () => {
      const req = buildCountRequest([valid1]);
      const results = [{ error: { message: 'Server rejected query' } }];
      const attached = attachCounts([valid1], req.rowIndex, results);
      expect(attached[0].count).toBeNull();
      expect(attached[0].error).toBe('Server rejected query');
    });
  });

  describe('resolveSavedSearchBadge', () => {
    it('returns error badge for views with error', () => {
      const badge = resolveSavedSearchBadge({
        scope: 'inbox',
        count: null,
        newCount: 0,
        inboxCount: 0,
        error: 'Syntax error',
      });
      expect(badge.style).toBe('error');
      expect(badge.variant).toBe('error');
      expect(badge.error).toBe('Syntax error');
    });

    it('returns none badge when count is null or zero', () => {
      const badgeNull = resolveSavedSearchBadge({
        scope: 'inbox',
        count: null,
        newCount: 0,
        inboxCount: 0,
        error: null,
      });
      expect(badgeNull.style).toBe('none');

      const badgeZero = resolveSavedSearchBadge({
        scope: 'inbox',
        count: 0,
        newCount: 0,
        inboxCount: 0,
        error: null,
      });
      expect(badgeZero.style).toBe('none');
    });

    it('renders inbox scope as orange-bubble when newCount > 0 and slate-bubble otherwise', () => {
      const orange = resolveSavedSearchBadge({
        scope: 'inbox',
        count: 5,
        newCount: 2,
        inboxCount: 5,
        error: null,
      });
      expect(orange.style).toBe('orange-bubble');
      expect(orange.variant).toBe('inbox');
      expect(orange.ariaLabel).toBe('5 items, some with new activity');

      const slate = resolveSavedSearchBadge({
        scope: 'inbox',
        count: 5,
        newCount: 0,
        inboxCount: 5,
        error: null,
      });
      expect(slate.style).toBe('slate-bubble');
      expect(slate.variant).toBe('inbox');
      expect(slate.ariaLabel).toBe('5 items');
    });

    it('renders new scope always as orange-bubble', () => {
      const badge = resolveSavedSearchBadge({
        scope: 'new',
        count: 3,
        newCount: 0,
        inboxCount: 3,
        error: null,
      });
      expect(badge.style).toBe('orange-bubble');
      expect(badge.variant).toBe('new');
      expect(badge.ariaLabel).toBe('3 items with new activity');
    });

    it('renders acked scope as faded', () => {
      const badge = resolveSavedSearchBadge({
        scope: 'acked',
        count: 7,
        newCount: 0,
        inboxCount: 0,
        error: null,
      });
      expect(badge.style).toBe('faded');
      expect(badge.variant).toBe('acked');
      expect(badge.ariaLabel).toBe('7 acked items');
    });

    it('picks inbox vs acked style for all-items badge from inboxCount', () => {
      // inboxCount > 0: inbox badge using inboxCount
      const withInbox = resolveSavedSearchBadge({
        scope: 'all',
        count: 12,
        newCount: 1,
        inboxCount: 4,
        error: null,
      });
      expect(withInbox.style).toBe('orange-bubble');
      expect(withInbox.variant).toBe('inbox');
      expect(withInbox.count).toBe(4);

      // inboxCount == 0: acked style using count
      const allAcked = resolveSavedSearchBadge({
        scope: 'all',
        count: 12,
        newCount: 0,
        inboxCount: 0,
        error: null,
      });
      expect(allAcked.style).toBe('faded');
      expect(allAcked.variant).toBe('acked');
      expect(allAcked.count).toBe(12);
    });
  });

  describe('isActive', () => {
    const unscopedView = toView({ id: '1', name: 'Repo', query: 'repo:kubernetes/kubernetes' });
    const scopedView = toView({ id: '2', name: 'Acked PRs', query: 'triage:acked type:pr' });
    const invalidView = toView({ id: '3', name: 'Invalid', query: 'state:bogus' });

    it('returns false when current query or saved search has issues', () => {
      expect(isActive(parseQuery('state:bogus'), unscopedView)).toBe(false);
      expect(isActive(parseQuery('repo:kubernetes/kubernetes'), invalidView)).toBe(false);
    });

    it('matches scoped search on exact canonical query', () => {
      expect(isActive(parseQuery('triage:acked type:pr'), scopedView)).toBe(true);
      expect(isActive(parseQuery('triage:inbox type:pr'), scopedView)).toBe(false);
    });

    it('matches unscoped search ignoring current tab clauses', () => {
      expect(isActive(parseQuery('repo:kubernetes/kubernetes'), unscopedView)).toBe(true);
      expect(isActive(parseQuery('new:any repo:kubernetes/kubernetes'), unscopedView)).toBe(true);
      expect(isActive(parseQuery('triage:acked repo:kubernetes/kubernetes'), unscopedView)).toBe(true);
      expect(isActive(parseQuery('repo:other/other'), unscopedView)).toBe(false);
    });
  });

  describe('reapplySavedSearchText (§7 re-apply in place)', () => {
    const unscoped = toView({ id: '1', name: 'Unscoped', query: 'repo:k/k' });
    const scopedNew = toView({ id: '2', name: 'Scoped New', query: 'new:any repo:k/k' });
    const scopedAcked = toView({ id: '3', name: 'Scoped Acked', query: 'triage:acked type:pr' });

    it.each([
      ['repo:k/k (unscoped)', unscoped, '', 'repo:k/k'],
      ['repo:k/k (unscoped)', unscoped, 'new:any', 'new:any repo:k/k'],
      ['repo:k/k (unscoped)', unscoped, 'triage:acked', 'triage:acked repo:k/k'],
      ['new:any repo:k/k (scoped)', scopedNew, '', 'new:any repo:k/k'],
      ['new:any repo:k/k (scoped)', scopedNew, 'new:any', 'new:any repo:k/k'],
      ['new:any repo:k/k (scoped)', scopedNew, 'triage:acked', 'new:any repo:k/k'],
      ['triage:acked type:pr (scoped)', scopedAcked, '', 'triage:acked type:pr'],
      ['triage:acked type:pr (scoped)', scopedAcked, 'new:any', 'triage:acked type:pr'],
      ['triage:acked type:pr (scoped)', scopedAcked, 'triage:acked', 'triage:acked type:pr'],
    ])('re-applying %s on "%s" results in "%s"', (_name, view, currentQuery, expected) => {
      const currentParsed = parseQuery(currentQuery);
      expect(reapplySavedSearchText(currentParsed, view)).toBe(expected);
    });
  });

  describe('suggestName', () => {
    it('suggests owner/name for a single repo query', () => {
      expect(suggestName('repo:kubernetes/kubernetes')).toBe('kubernetes/kubernetes');
    });

    it('ignores tab clauses when suggesting a repo name', () => {
      expect(suggestName('triage:acked repo:k/k')).toBe('k/k');
      expect(suggestName('new:any repo:kubernetes/kubernetes')).toBe('kubernetes/kubernetes');
    });

    it('truncates longer non-repo queries to 40 characters with ellipsis', () => {
      const query = 'label:sig/node is:open author:alice milestone:v1.30';
      const name = suggestName(query);
      expect(name).toBe('label:sig/node is:open author:alice mil…');
      expect(Array.from(name)).toHaveLength(40);
    });
  });

  describe('moveItem', () => {
    it('moves elements correctly', () => {
      expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
      expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
      expect(moveItem(['a', 'b', 'c', 'd'], 1, 1)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('handles out of bounds indices without modifying array', () => {
      expect(moveItem(['a', 'b'], -1, 1)).toEqual(['a', 'b']);
      expect(moveItem(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
    });
  });

  describe('validateSavedSearchName', () => {
    it('validates name emptiness, length, control characters, and uniqueness', () => {
      expect(validateSavedSearchName('')).toBe('Name is required.');
      expect(validateSavedSearchName('   ')).toBe('Name is required.');
      expect(validateSavedSearchName('a\nb')).toBe('Name cannot contain control characters.');
      expect(validateSavedSearchName('x'.repeat(81))).toBe('Name cannot exceed 80 characters.');

      const existing = [{ id: 's1', name: 'My Search' }];
      expect(validateSavedSearchName('my search', existing)).toBe(
        'A saved search with this name already exists.'
      );
      // Valid when renaming itself
      expect(validateSavedSearchName('my search', existing, 's1')).toBeNull();
      // Valid when new unique name
      expect(validateSavedSearchName('other', existing)).toBeNull();
    });
  });
});
