import type { NotificationFilters } from './types';
import type { Item } from '../api/octodeck/v1/resources_pb';
import { CommentNoiseType } from '../api/octodeck/v1/resources_pb';
import { getProtoTimestampMs } from '../logic/timeline';

export function matchPatterns(value: string | undefined | null, patterns: string[]): boolean {
  if (!value || !patterns || patterns.length === 0) return false;
  const val = value.trim().toLowerCase();
  if (!val) return false;

  return patterns.some(pattern => {
    const p = pattern.trim().toLowerCase();
    if (!p) return false;
    if (p.includes('*')) {
      const regexStr = '^' + p.split('*').map(s => s.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&')).join('.*') + '$';
      try {
        return new RegExp(regexStr).test(val);
      } catch {
        return false;
      }
    }
    return val === p;
  });
}

export function isItemAssignedOrAuthored(item: Item, currentUserLogin?: string): boolean {
  if (!currentUserLogin) return false;
  const user = currentUserLogin.trim().toLowerCase();

  const isAuthor = Boolean(item.author?.login && item.author.login.trim().toLowerCase() === user);
  const isAssigned = (item.assignees || []).some(
    a => a.login && a.login.trim().toLowerCase() === user
  );

  return isAuthor || isAssigned;
}

export function isSelfUser(userLogin: string | undefined | null, currentUserLogin?: string): boolean {
  if (!userLogin || !currentUserLogin) return false;
  return userLogin.trim().toLowerCase() === currentUserLogin.trim().toLowerCase();
}

function isBotAuthor(login: string | undefined | null): boolean {
  if (!login) return false;
  const l = login.trim().toLowerCase();
  return l.endsWith('[bot]') || l.includes('robot');
}

export function shouldNotifyItem(
  item: Item,
  filters: NotificationFilters,
  currentUserLogin?: string,
  lastNotifiedAtMs?: number
): boolean {
  if (!filters.enabled) return false;

  if (filters.onlyAssignedOrAuthored && currentUserLogin) {
    if (!isItemAssignedOrAuthored(item, currentUserLogin)) {
      return false;
    }
  }

  const repoMatches = matchPatterns(item.repo, filters.repos);
  const itemLabels = (item.labels || []).map(l => l.name || '');
  const labelMatches = itemLabels.some(l => matchPatterns(l, filters.labels));
  const authorMatches = item.author?.login ? matchPatterns(item.author.login, filters.authors) : false;

  if (filters.filterMode === 'include') {
    if (filters.repos.length > 0 && !repoMatches) return false;
    if (filters.labels.length > 0 && !labelMatches) return false;
    if (filters.authors.length > 0 && !authorMatches) return false;
  } else {
    // Exclude mode
    if (filters.repos.length > 0 && repoMatches) return false;
    if (filters.labels.length > 0 && labelMatches) return false;
    if (filters.authors.length > 0 && authorMatches) return false;
  }

  const updatedAtMs = getProtoTimestampMs(item.updatedAt);
  const isNewItem = !lastNotifiedAtMs;

  if (isNewItem) {
    return filters.notifyOnNewItems;
  }

  if (updatedAtMs <= lastNotifiedAtMs) {
    return false;
  }

  if (!filters.notifyOnNewActivity) {
    return false;
  }

  return checkForRecentActivity(item, lastNotifiedAtMs, currentUserLogin, filters.ignoreBots);
}

export function checkForRecentActivity(
  item: Item,
  sinceMs: number,
  currentUserLogin?: string,
  ignoreBots?: boolean
): boolean {
  const recentComments = (item.comments || []).filter(c => {
    const commentTime = getProtoTimestampMs(c.createdAt);
    return commentTime > sinceMs;
  });

  const recentReviews = (item.reviews || []).filter(r => {
    const reviewTime = getProtoTimestampMs(r.submittedAt);
    return reviewTime > sinceMs;
  });

  const recentCommits = (item.commits || []).filter(c => {
    const commitTime = getProtoTimestampMs(c.committedDate);
    return commitTime > sinceMs;
  });

  const recentStateEvents = (item.stateEvents || []).filter(e => {
    const eventTime = getProtoTimestampMs(e.createdAt);
    return eventTime > sinceMs;
  });

  const totalRecentEvents =
    recentComments.length + recentReviews.length + recentCommits.length + recentStateEvents.length;

  if (totalRecentEvents === 0) {
    // Title/body/label/state/milestone updates without timestamped events count as external activity
    return true;
  }

  const hasQualifyingComment = recentComments.some(c => {
    if (isSelfUser(c.author?.login, currentUserLogin)) {
      return false;
    }
    if (ignoreBots) {
      if (
        c.noiseType === CommentNoiseType.BOT_AUTHOR ||
        c.noiseType === CommentNoiseType.SLASH_COMMAND ||
        isBotAuthor(c.author?.login)
      ) {
        return false;
      }
    }
    return true;
  });

  const hasQualifyingReview = recentReviews.some(r => {
    if (isSelfUser(r.author?.login, currentUserLogin)) {
      return false;
    }
    if (ignoreBots && isBotAuthor(r.author?.login)) {
      return false;
    }
    return true;
  });

  const hasQualifyingCommit = recentCommits.some(c => {
    if (isSelfUser(c.authorLogin, currentUserLogin)) {
      return false;
    }
    if (ignoreBots && isBotAuthor(c.authorLogin)) {
      return false;
    }
    return true;
  });

  const hasQualifyingStateEvent = recentStateEvents.some(e => {
    if (isSelfUser(e.actor?.login, currentUserLogin)) {
      return false;
    }
    if (ignoreBots && isBotAuthor(e.actor?.login)) {
      return false;
    }
    return true;
  });

  return (
    hasQualifyingComment ||
    hasQualifyingReview ||
    hasQualifyingCommit ||
    hasQualifyingStateEvent
  );
}

export function checkForRecentHumanActivity(item: Item, sinceMs: number, currentUserLogin?: string): boolean {
  return checkForRecentActivity(item, sinceMs, currentUserLogin, true);
}

export function buildNotificationContent(item: Item): { title: string; message: string } {
  const number = item.number ? `#${item.number}` : '';
  const repo = item.repo || '';
  const title = `${repo}${number ? ` ${number}` : ''}`;
  const message = item.title ? item.title : 'New activity on item';
  return { title, message };
}
