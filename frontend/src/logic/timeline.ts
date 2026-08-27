import type { Item } from '../api/octodeck/v1/resources_pb';
import { ItemState, StateChangeType, CommentNoiseType } from '../api/octodeck/v1/resources_pb';
import { isNoise, isFailureText, type BotSummaryGroup } from './noiseFilter';
import type { Timestamp } from '@bufbuild/protobuf/wkt';

export function getProtoTimestampMs(ts?: Timestamp | string | null): number {
    if (!ts) return 0;
    if (typeof ts === 'string') {
        const parsed = Date.parse(ts);
        return isNaN(parsed) ? 0 : parsed;
    }
    return Number(ts.seconds) * 1000 + Math.floor((ts.nanos || 0) / 1000000);
}

export type TimelineCommitEntry = {
    type: 'COMMIT';
    authorLogin: string;
    timestamp: string;
};

export type TimelineStateChangeEntry = {
    type: 'STATE_CHANGE';
    changeType: 'CLOSED' | 'MERGED' | 'REOPENED' | 'ASSIGNED';
    actor: {
        login: string;
        avatarUrl?: string;
    };
    timestamp: string;
    url?: string;
};

export type TimelineCommentEntry = {
    type: 'COMMENT';
    data: {
        bodyText: string;
        author: {
            login: string;
            avatarUrl: string;
        };
        url?: string;
        createdAt?: string;
        noiseType?: CommentNoiseType;
    };
    timestamp: string;
};

export type TimelineReviewComment = {
    id: string;
    body: string;
    path?: string;
    url?: string;
    author?: { login: string; avatarUrl?: string };
    createdAt?: string;
    replyToId?: string;
};

export type TimelineReviewEntry = {
    type: 'REVIEW';
    author: {
        login: string;
        avatarUrl?: string;
    };
    state: string;
    timestamp: string;
    body?: string;
    commentCount?: number;
    newThreadsCount?: number;
    replyCount?: number;
    comments?: TimelineReviewComment[];
    url?: string;
};

export type { BotSummaryGroup };

export type TimelineEntry =
    | TimelineCommentEntry
    | TimelineCommitEntry
    | TimelineReviewEntry
    | TimelineStateChangeEntry
    | BotSummaryGroup;

export function buildTimeline(item: Item): TimelineEntry[] {
    const rawComments: {
        bodyText: string;
        authorLogin: string;
        authorAvatar: string;
        timestamp: string;
        url?: string;
        noiseType?: CommentNoiseType;
    }[] = [];
    const rawCommits: { authorLogin: string; timestamp: string }[] = [];
    const rawReviews: {
        authorLogin: string;
        authorAvatar: string;
        state: string;
        timestamp: string;
        body?: string;
        commentCount?: number;
        newThreadsCount?: number;
        replyCount?: number;
        comments?: TimelineReviewComment[];
        url?: string;
    }[] = [];

    const fallbackDateIso = new Date(0).toISOString();

    (item.comments || []).forEach(c => {
        const ms = getProtoTimestampMs(c.createdAt);
        const commentUrl = c.commentId && item.url
            ? `${item.url.replace(/\/+$/, '')}#issuecomment-${c.commentId}`
            : item.url;
        rawComments.push({
            bodyText: c.bodyText || '',
            authorLogin: c.author?.login || 'unknown',
            authorAvatar: c.author?.avatarUrl || 'https://github.com/ghost.png',
            timestamp: ms ? new Date(ms).toISOString() : fallbackDateIso,
            url: commentUrl,
            noiseType: c.noiseType,
        });
    });
    (item.commits || []).forEach(c => {
        const ms = getProtoTimestampMs(c.committedDate);
        rawCommits.push({
            authorLogin: c.authorLogin || 'unknown',
            timestamp: ms ? new Date(ms).toISOString() : fallbackDateIso,
        });
    });
    (item.reviews || []).forEach(r => {
        const ms = getProtoTimestampMs(r.submittedAt);
        const parsedComments: TimelineReviewComment[] = (r.comments || []).map(rc => {
            const rcMs = getProtoTimestampMs(rc.createdAt);
            return {
                id: rc.id || '',
                body: rc.body || '',
                path: rc.path || '',
                url: rc.url || '',
                author: {
                    login: rc.author?.login || 'unknown',
                    avatarUrl: rc.author?.avatarUrl || 'https://github.com/ghost.png',
                },
                createdAt: rcMs ? new Date(rcMs).toISOString() : undefined,
                replyToId: rc.replyToId || undefined,
            };
        });

        rawReviews.push({
            authorLogin: r.author?.login || 'unknown',
            authorAvatar: r.author?.avatarUrl || 'https://github.com/ghost.png',
            state: r.state || 'COMMENTED',
            timestamp: ms ? new Date(ms).toISOString() : fallbackDateIso,
            body: r.body || '',
            commentCount: r.commentCount || 0,
            newThreadsCount: r.newThreadsCount || 0,
            replyCount: r.replyCount || 0,
            comments: parsedComments,
            url: r.url || '',
        });
    });

    const commentEntries: TimelineCommentEntry[] = rawComments.map(c => ({
        type: 'COMMENT' as const,
        data: {
            bodyText: c.bodyText,
            author: {
                login: c.authorLogin,
                avatarUrl: c.authorAvatar,
            },
            url: c.url,
            createdAt: c.timestamp,
            noiseType: c.noiseType,
        },
        timestamp: c.timestamp,
    }));

    const reviewEntries: TimelineReviewEntry[] = rawReviews.map(r => ({
        type: 'REVIEW' as const,
        author: {
            login: r.authorLogin,
            avatarUrl: r.authorAvatar,
        },
        state: r.state,
        timestamp: r.timestamp,
        body: r.body,
        commentCount: r.commentCount,
        newThreadsCount: r.newThreadsCount,
        replyCount: r.replyCount,
        comments: r.comments,
        url: r.url,
    }));

    // Condense commit events to only the most recent commit
    let commitEntries: TimelineCommitEntry[] = [];
    if (rawCommits.length > 0) {
        const latestCommit = rawCommits.reduce((latest, current) => {
            const latestMs = new Date(latest.timestamp).getTime();
            const currentMs = new Date(current.timestamp).getTime();
            return currentMs > latestMs ? current : latest;
        });
        commitEntries = [{
            type: 'COMMIT' as const,
            authorLogin: latestCommit.authorLogin,
            timestamp: latestCommit.timestamp,
        }];
    }

    const rawStateEvents: TimelineStateChangeEntry[] = [];
    (item.stateEvents || []).forEach(e => {
        const ms = getProtoTimestampMs(e.createdAt);
        let changeType: 'CLOSED' | 'MERGED' | 'REOPENED' | 'ASSIGNED' | null = null;
        if (e.type === StateChangeType.CLOSED || (e.type as number) === 1) {
            changeType = 'CLOSED';
        } else if (e.type === StateChangeType.MERGED || (e.type as number) === 2) {
            changeType = 'MERGED';
        } else if (e.type === StateChangeType.REOPENED || (e.type as number) === 3) {
            changeType = 'REOPENED';
        } else if (e.type === StateChangeType.ASSIGNED || (e.type as number) === 4) {
            changeType = 'ASSIGNED';
        }

        if (changeType) {
            rawStateEvents.push({
                type: 'STATE_CHANGE' as const,
                changeType,
                actor: {
                    login: e.actor?.login || 'unknown',
                    avatarUrl: e.actor?.avatarUrl || 'https://github.com/ghost.png',
                },
                timestamp: ms ? new Date(ms).toISOString() : fallbackDateIso,
                url: e.url || item.url,
            });
        }
    });

    // Fallback if no stateEvents were populated but item is CLOSED or MERGED
    if (rawStateEvents.length === 0) {
        if (item.state === ItemState.MERGED) {
            const ms = getProtoTimestampMs(item.updatedAt);
            rawStateEvents.push({
                type: 'STATE_CHANGE' as const,
                changeType: 'MERGED',
                actor: {
                    login: 'unknown',
                    avatarUrl: 'https://github.com/ghost.png',
                },
                timestamp: ms ? new Date(ms).toISOString() : fallbackDateIso,
                url: item.url,
            });
        } else if (item.state === ItemState.CLOSED) {
            const ms = getProtoTimestampMs(item.updatedAt);
            rawStateEvents.push({
                type: 'STATE_CHANGE' as const,
                changeType: 'CLOSED',
                actor: {
                    login: 'unknown',
                    avatarUrl: 'https://github.com/ghost.png',
                },
                timestamp: ms ? new Date(ms).toISOString() : fallbackDateIso,
                url: item.url,
            });
        }
    }

    // Suppress CLOSED events that occur at or after a MERGED event (or within 1s before due to timestamp precision)
    const mergedEvents = rawStateEvents.filter(e => e.changeType === 'MERGED');
    const filteredStateEvents = mergedEvents.length > 0
        ? rawStateEvents.filter(e => {
            if (e.changeType !== 'CLOSED') {
                return true;
            }
            const closeMs = new Date(e.timestamp).getTime();
            const isMergedClose = mergedEvents.some(m => closeMs >= new Date(m.timestamp).getTime() - 1000);
            return !isMergedClose;
        })
        : rawStateEvents;

    const mixed = [...commentEntries, ...commitEntries, ...reviewEntries, ...filteredStateEvents].sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const timeline: TimelineEntry[] = [];
    let currentBotGroup: BotSummaryGroup | null = null;

    for (const entry of mixed) {
        if (entry.type === 'COMMIT' || entry.type === 'REVIEW' || entry.type === 'STATE_CHANGE') {
            if (currentBotGroup) {
                timeline.push(currentBotGroup);
                currentBotGroup = null;
            }
            timeline.push(entry);
        } else {
            const comment = entry.data;
            const noise = isNoise(comment);

            if (noise) {
                const hasFailure = isFailureText(comment.bodyText);
                const botCommentObj = {
                    bodyText: comment.bodyText,
                    author: {
                        login: comment.author.login,
                        avatarUrl: comment.author.avatarUrl,
                    },
                    url: comment.url,
                    createdAt: comment.createdAt || entry.timestamp,
                    noiseType: comment.noiseType,
                };

                if (currentBotGroup) {
                    currentBotGroup.count++;
                    if (hasFailure) currentBotGroup.hasFailure = true;
                    currentBotGroup.timestamp = entry.timestamp;
                    if (!currentBotGroup.authors.includes(comment.author.login)) {
                        currentBotGroup.authors.push(comment.author.login);
                    }
                    currentBotGroup.comments.push(botCommentObj);
                } else {
                    currentBotGroup = {
                        type: 'BOT_SUMMARY',
                        count: 1,
                        hasFailure,
                        timestamp: entry.timestamp,
                        authors: [comment.author.login],
                        comments: [botCommentObj],
                    };
                }
            } else {
                if (currentBotGroup) {
                    timeline.push(currentBotGroup);
                    currentBotGroup = null;
                }
                timeline.push(entry);
            }
        }
    }

    if (currentBotGroup) {
        timeline.push(currentBotGroup);
    }

    return timeline;
}

export interface CiFailureSummary {
    hasFailure: boolean;
    failureCount: number;
    failingAuthors: string[];
    failedComments: {
        authorLogin: string;
        bodyText: string;
        timestamp: string;
        url?: string;
    }[];
}

export function getCiFailureSummary(timeline: TimelineEntry[]): CiFailureSummary {
    const failedComments: {
        authorLogin: string;
        bodyText: string;
        timestamp: string;
        url?: string;
    }[] = [];
    const failingAuthors = new Set<string>();

    for (const entry of timeline) {
        if (entry.type === 'BOT_SUMMARY') {
            for (const c of entry.comments) {
                if (isFailureText(c.bodyText)) {
                    failedComments.push({
                        authorLogin: c.author.login,
                        bodyText: c.bodyText,
                        timestamp: c.createdAt || entry.timestamp,
                        url: c.url,
                    });
                    if (c.author.login) {
                        failingAuthors.add(c.author.login);
                    }
                }
            }
        }
    }

    return {
        hasFailure: failedComments.length > 0,
        failureCount: failedComments.length,
        failingAuthors: Array.from(failingAuthors),
        failedComments,
    };
}

export function hasCiFailures(timeline: TimelineEntry[]): boolean {
    return timeline.some(entry => entry.type === 'BOT_SUMMARY' && entry.hasFailure);
}

export function getLatestRelevantActivity(
    timeline: TimelineEntry[]
): TimelineCommentEntry | TimelineCommitEntry | TimelineReviewEntry | TimelineStateChangeEntry | null {
    for (let i = timeline.length - 1; i >= 0; i--) {
        const entry = timeline[i];
        if (entry.type === 'COMMIT' || entry.type === 'COMMENT' || entry.type === 'REVIEW' || entry.type === 'STATE_CHANGE') {
            return entry;
        }
    }
    return null;
}

export function getLatestNonNoiseActivityMs(item: Item): number {
    const timeline = buildTimeline(item);
    const latest = getLatestRelevantActivity(timeline);
    const createdAtMs = getProtoTimestampMs(item.createdAt);
    const updatedAtMs = getProtoTimestampMs(item.updatedAt);

    if (latest) {
        const latestMs = new Date(latest.timestamp).getTime();
        return Math.max(createdAtMs, latestMs);
    }
    return createdAtMs > 0 ? createdAtMs : updatedAtMs;
}

export function formatReviewCommentSummary(review: {
    commentCount?: number;
    newThreadsCount?: number;
    replyCount?: number;
}): string {
    const threads = review.newThreadsCount ?? 0;
    const replies = review.replyCount ?? 0;

    if (threads > 0 && replies > 0) {
        return `${threads} ${threads === 1 ? 'comment' : 'comments'}, ${replies} ${replies === 1 ? 'reply' : 'replies'}`;
    }
    if (threads > 0) {
        return `${threads} ${threads === 1 ? 'comment' : 'comments'}`;
    }
    if (replies > 0) {
        return `${replies} ${replies === 1 ? 'reply' : 'replies'}`;
    }
    if (review.commentCount && review.commentCount > 0) {
        return `${review.commentCount} ${review.commentCount === 1 ? 'comment' : 'comments'}`;
    }
    return '';
}

export function getFilesViewUrl(url?: string): string | undefined {
    if (!url) return undefined;
    let res = url;
    if (!res.includes('/files#') && !res.includes('/files?') && !res.includes('/changes#') && !res.includes('/changes?')) {
        res = res.replace(/(\/pull\/\d+)(#.*)?$/, '$1/files$2');
    }
    return res.replace('#discussion_r', '#r');
}
