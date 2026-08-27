/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import {
  matchPatterns,
  isItemAssignedOrAuthored,
  shouldNotifyItem,
  buildNotificationContent,
} from '../notifications';
import { DEFAULT_NOTIFICATION_FILTERS, type NotificationFilters } from '../types';
import type { Item, User } from '../../api/octodeck/v1/resources_pb';
import { CommentNoiseType } from '../../api/octodeck/v1/resources_pb';

const mockItem: Partial<Item> = {
  id: 'kubernetes/kubernetes#12345',
  repo: 'kubernetes/kubernetes',
  number: 12345,
  title: 'Fix edge case in kubelet sync loop',
  url: 'https://github.com/kubernetes/kubernetes/pull/12345',
  author: { login: 'alice', avatarUrl: '' } as User,
  assignees: [{ login: 'bob', avatarUrl: '' } as User],
  labels: [{ name: 'area/node', color: '0075ca' } as any, { name: 'sig/node', color: 'd73a4a' } as any],
  updatedAt: { seconds: BigInt(1700001000), nanos: 0 } as any,
  comments: [],
  reviews: [],
};

describe('Notifications Filter Engine', () => {
  describe('matchPatterns', () => {
    it('matches exact strings case-insensitively', () => {
      expect(matchPatterns('kubernetes/kubernetes', ['kubernetes/kubernetes'])).toBe(true);
      expect(matchPatterns('Kubernetes/Kubernetes', ['kubernetes/kubernetes'])).toBe(true);
      expect(matchPatterns('kubernetes/other', ['kubernetes/kubernetes'])).toBe(false);
    });

    it('matches wildcard patterns correctly', () => {
      expect(matchPatterns('kubernetes/kubernetes', ['kubernetes/*'])).toBe(true);
      expect(matchPatterns('kubernetes/kops', ['kubernetes/*'])).toBe(true);
      expect(matchPatterns('containernetworking/plugins', ['kubernetes/*'])).toBe(false);
      expect(matchPatterns('area/node', ['area/*'])).toBe(true);
      expect(matchPatterns('sig/node', ['area/*'])).toBe(false);
    });

    it('handles empty or undefined inputs safely', () => {
      expect(matchPatterns('', ['test'])).toBe(false);
      expect(matchPatterns(null, ['test'])).toBe(false);
      expect(matchPatterns('test', [])).toBe(false);
    });
  });

  describe('isItemAssignedOrAuthored', () => {
    it('returns true when user is the author', () => {
      expect(isItemAssignedOrAuthored(mockItem as Item, 'alice')).toBe(true);
      expect(isItemAssignedOrAuthored(mockItem as Item, 'Alice')).toBe(true);
    });

    it('returns true when user is in assignees', () => {
      expect(isItemAssignedOrAuthored(mockItem as Item, 'bob')).toBe(true);
      expect(isItemAssignedOrAuthored(mockItem as Item, 'Bob')).toBe(true);
    });

    it('returns false when user is neither author nor assigned', () => {
      expect(isItemAssignedOrAuthored(mockItem as Item, 'charlie')).toBe(false);
      expect(isItemAssignedOrAuthored(mockItem as Item, undefined)).toBe(false);
    });
  });

  describe('shouldNotifyItem', () => {
    it('returns false when notifications are globally disabled', () => {
      const filters: NotificationFilters = {
        ...DEFAULT_NOTIFICATION_FILTERS,
        enabled: false,
      };
      expect(shouldNotifyItem(mockItem as Item, filters, 'alice')).toBe(false);
    });

    it('filters out items not assigned or authored when onlyAssignedOrAuthored is true', () => {
      const filters: NotificationFilters = {
        ...DEFAULT_NOTIFICATION_FILTERS,
        onlyAssignedOrAuthored: true,
      };
      expect(shouldNotifyItem(mockItem as Item, filters, 'alice')).toBe(true);
      expect(shouldNotifyItem(mockItem as Item, filters, 'bob')).toBe(true);
      expect(shouldNotifyItem(mockItem as Item, filters, 'charlie')).toBe(false);
    });

    it('respects Exclude filter mode for repositories and labels', () => {
      const filters: NotificationFilters = {
        ...DEFAULT_NOTIFICATION_FILTERS,
        filterMode: 'exclude',
        repos: ['kubernetes/*'],
        labels: [],
      };
      expect(shouldNotifyItem(mockItem as Item, filters, 'alice')).toBe(false);

      const labelExcludeFilters: NotificationFilters = {
        ...DEFAULT_NOTIFICATION_FILTERS,
        filterMode: 'exclude',
        repos: [],
        labels: ['area/node'],
      };
      expect(shouldNotifyItem(mockItem as Item, labelExcludeFilters, 'alice')).toBe(false);
    });

    it('respects Include filter mode for repositories and labels', () => {
      const filtersIncludeMatch: NotificationFilters = {
        ...DEFAULT_NOTIFICATION_FILTERS,
        filterMode: 'include',
        repos: ['kubernetes/*'],
        labels: ['area/*'],
      };
      expect(shouldNotifyItem(mockItem as Item, filtersIncludeMatch, 'alice')).toBe(true);

      const filtersIncludeMismatch: NotificationFilters = {
        ...DEFAULT_NOTIFICATION_FILTERS,
        filterMode: 'include',
        repos: ['octodeck/*'],
      };
      expect(shouldNotifyItem(mockItem as Item, filtersIncludeMismatch, 'alice')).toBe(false);
    });

    it('ignores updates when only bot comments occurred and ignoreBots is true', () => {
      const itemWithBotUpdate: Partial<Item> = {
        ...mockItem,
        updatedAt: { seconds: BigInt(1700002000), nanos: 0 } as any,
        comments: [
          {
            author: { login: 'k8s-ci-robot[bot]', avatarUrl: '' } as User,
            bodyText: 'Tests passed on commit abc',
            createdAt: { seconds: BigInt(1700001900), nanos: 0 } as any,
            noiseType: CommentNoiseType.BOT_AUTHOR,
          } as any,
        ],
      };

      const filters: NotificationFilters = {
        ...DEFAULT_NOTIFICATION_FILTERS,
        ignoreBots: true,
      };

      // lastNotified was at 1700001500 (before bot comment at 1700001900)
      expect(shouldNotifyItem(itemWithBotUpdate as Item, filters, 'alice', 1700001500000)).toBe(false);
    });

    it('triggers notification when human comment occurred since last notification', () => {
      const itemWithHumanUpdate: Partial<Item> = {
        ...mockItem,
        updatedAt: { seconds: BigInt(1700002000), nanos: 0 } as any,
        comments: [
          {
            author: { login: 'seniorDev', avatarUrl: '' } as User,
            bodyText: 'Please review the updated diff',
            createdAt: { seconds: BigInt(1700001900), nanos: 0 } as any,
            noiseType: CommentNoiseType.UNSPECIFIED,
          } as any,
        ],
      };

      const filters: NotificationFilters = {
        ...DEFAULT_NOTIFICATION_FILTERS,
        ignoreBots: true,
      };

      expect(shouldNotifyItem(itemWithHumanUpdate as Item, filters, 'alice', 1700001500000)).toBe(true);
    });

    it('suppresses notification when recent comment was by current user (self activity)', () => {
      const itemWithSelfComment: Partial<Item> = {
        ...mockItem,
        updatedAt: { seconds: BigInt(1700002000), nanos: 0 } as any,
        comments: [
          {
            author: { login: 'alice', avatarUrl: '' } as User,
            bodyText: 'I commented on this issue',
            createdAt: { seconds: BigInt(1700001900), nanos: 0 } as any,
            noiseType: CommentNoiseType.UNSPECIFIED,
          } as any,
        ],
      };

      const filters: NotificationFilters = {
        ...DEFAULT_NOTIFICATION_FILTERS,
        ignoreBots: false,
      };

      expect(shouldNotifyItem(itemWithSelfComment as Item, filters, 'alice', 1700001500000)).toBe(false);
      expect(shouldNotifyItem(itemWithSelfComment as Item, filters, 'Alice', 1700001500000)).toBe(false);
      // Someone else receives notification
      expect(shouldNotifyItem(itemWithSelfComment as Item, filters, 'bob', 1700001500000)).toBe(true);
    });

    it('suppresses notification when recent review was submitted by current user (self activity)', () => {
      const itemWithSelfReview: Partial<Item> = {
        ...mockItem,
        updatedAt: { seconds: BigInt(1700002000), nanos: 0 } as any,
        reviews: [
          {
            author: { login: 'alice', avatarUrl: '' } as User,
            body: 'LGTM!',
            submittedAt: { seconds: BigInt(1700001900), nanos: 0 } as any,
          } as any,
        ],
      };

      const filters: NotificationFilters = {
        ...DEFAULT_NOTIFICATION_FILTERS,
      };

      expect(shouldNotifyItem(itemWithSelfReview as Item, filters, 'alice', 1700001500000)).toBe(false);
      expect(shouldNotifyItem(itemWithSelfReview as Item, filters, 'bob', 1700001500000)).toBe(true);
    });

    it('suppresses notification when recent commit was pushed by current user (self activity)', () => {
      const itemWithSelfCommit: Partial<Item> = {
        ...mockItem,
        updatedAt: { seconds: BigInt(1700002000), nanos: 0 } as any,
        commits: [
          {
            authorLogin: 'alice',
            committedDate: { seconds: BigInt(1700001900), nanos: 0 } as any,
          } as any,
        ],
      };

      const filters: NotificationFilters = {
        ...DEFAULT_NOTIFICATION_FILTERS,
      };

      expect(shouldNotifyItem(itemWithSelfCommit as Item, filters, 'alice', 1700001500000)).toBe(false);
      expect(shouldNotifyItem(itemWithSelfCommit as Item, filters, 'bob', 1700001500000)).toBe(true);
    });

    it('suppresses notification when recent state event was performed by current user (self activity)', () => {
      const itemWithSelfStateEvent: Partial<Item> = {
        ...mockItem,
        updatedAt: { seconds: BigInt(1700002000), nanos: 0 } as any,
        stateEvents: [
          {
            actor: { login: 'alice', avatarUrl: '' } as User,
            createdAt: { seconds: BigInt(1700001900), nanos: 0 } as any,
          } as any,
        ],
      };

      const filters: NotificationFilters = {
        ...DEFAULT_NOTIFICATION_FILTERS,
      };

      expect(shouldNotifyItem(itemWithSelfStateEvent as Item, filters, 'alice', 1700001500000)).toBe(false);
      expect(shouldNotifyItem(itemWithSelfStateEvent as Item, filters, 'bob', 1700001500000)).toBe(true);
    });

    it('triggers notification when mixed activity contains comment by another user along with self comment', () => {
      const itemWithMixedComments: Partial<Item> = {
        ...mockItem,
        updatedAt: { seconds: BigInt(1700002000), nanos: 0 } as any,
        comments: [
          {
            author: { login: 'alice', avatarUrl: '' } as User,
            bodyText: 'My comment',
            createdAt: { seconds: BigInt(1700001800), nanos: 0 } as any,
            noiseType: CommentNoiseType.UNSPECIFIED,
          } as any,
          {
            author: { login: 'charlie', avatarUrl: '' } as User,
            bodyText: 'Charlie comment',
            createdAt: { seconds: BigInt(1700001900), nanos: 0 } as any,
            noiseType: CommentNoiseType.UNSPECIFIED,
          } as any,
        ],
      };

      const filters: NotificationFilters = {
        ...DEFAULT_NOTIFICATION_FILTERS,
      };

      expect(shouldNotifyItem(itemWithMixedComments as Item, filters, 'alice', 1700001500000)).toBe(true);
    });
  });

  describe('buildNotificationContent', () => {
    it('creates well-formatted title and body', () => {
      const content = buildNotificationContent(mockItem as Item);
      expect(content.title).toBe('kubernetes/kubernetes #12345');
      expect(content.message).toBe('Fix edge case in kubelet sync loop');
    });
  });
});
