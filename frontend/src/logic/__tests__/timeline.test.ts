/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import {
    buildTimeline,
    getCiFailureSummary,
    hasCiFailures,
    getLatestRelevantActivity,
    getLatestNonNoiseActivityMs,
    getProtoTimestampMs,
    formatReviewCommentSummary,
    getFilesViewUrl,
    getThreadContext,
    type TimelineEntry
} from '../timeline';
import type { Item } from '../../api/octodeck/v1/resources_pb';
import { ItemType, ItemState, ItemStatus, CommentNoiseType } from '../../api/octodeck/v1/resources_pb';

describe('timeline logic', () => {
    describe('getProtoTimestampMs', () => {
        it('returns 0 for undefined timestamp', () => {
            expect(getProtoTimestampMs(undefined)).toBe(0);
        });

        it('calculates ms correctly from seconds and nanos', () => {
            const ts = { seconds: BigInt(1700000000), nanos: 500000000 };
            expect(getProtoTimestampMs(ts as any)).toBe(1700000000500);
        });
    });

    describe('buildTimeline - commit condensation', () => {
        it('condenses multiple commits into only the single most recent commit', () => {
            const item: Partial<Item> = {
                id: 'owner/repo#1',
                repo: 'owner/repo',
                number: 1,
                type: ItemType.PR,
                title: 'Multi-commit PR',
                state: ItemState.OPEN,
                url: 'https://github.com/owner/repo/pull/1',
                author: { login: 'octo', avatarUrl: 'https://avatar.url' } as any,
                commits: [
                    { authorLogin: 'octo', committedDate: { seconds: BigInt(1700000100), nanos: 0 } } as any,
                    { authorLogin: 'octo', committedDate: { seconds: BigInt(1700000900), nanos: 0 } } as any,
                    { authorLogin: 'octo', committedDate: { seconds: BigInt(1700000500), nanos: 0 } } as any,
                ],
                comments: [],
                reviews: [],
            };

            const timeline = buildTimeline(item as Item);
            const commitEntries = timeline.filter(e => e.type === 'COMMIT');

            expect(commitEntries).toHaveLength(1);
            expect(commitEntries[0].timestamp).toBe(new Date(1700000900000).toISOString());
        });

        it('handles items with no commits', () => {
            const item: Partial<Item> = {
                id: 'owner/repo#2',
                repo: 'owner/repo',
                number: 2,
                type: ItemType.PR,
                title: 'No commit PR',
                state: ItemState.OPEN,
                url: 'https://github.com/owner/repo/pull/2',
                author: { login: 'octo', avatarUrl: 'https://avatar.url' } as any,
                commits: [],
                comments: [
                    {
                        bodyText: 'Hello world',
                        author: { login: 'reviewer' } as any,
                        createdAt: { seconds: BigInt(1700000100), nanos: 0 },
                        commentId: BigInt(1),
                    } as any,
                ],
                reviews: [],
            };

            const timeline = buildTimeline(item as Item);
            const commitEntries = timeline.filter(e => e.type === 'COMMIT');
            expect(commitEntries).toHaveLength(0);
            expect(timeline).toHaveLength(1);
            expect(timeline[0].type).toBe('COMMENT');
        });

        it('condenses commits in Protobuf Item representation', () => {
            const protoItem: Partial<Item> = {
                id: 'owner/repo#10',
                repo: 'owner/repo',
                number: 10,
                type: ItemType.PR,
                title: 'Proto PR',
                state: ItemState.OPEN,
                url: 'https://github.com/owner/repo/pull/10',
                author: { login: 'dev', avatarUrl: '', type: 1 } as any,
                commits: [
                    {
                        authorLogin: 'dev',
                        committedDate: { seconds: BigInt(1700000100), nanos: 0 },
                    } as any,
                    {
                        authorLogin: 'dev-pair',
                        committedDate: { seconds: BigInt(1700000900), nanos: 0 },
                    } as any,
                    {
                        authorLogin: 'dev',
                        committedDate: { seconds: BigInt(1700000500), nanos: 0 },
                    } as any,
                ],
                comments: [],
                reviews: [],
                assignees: [],
                local: {
                    computedStatus: ItemStatus.NEW_CODE,
                    isAcked: false,
                    privateNotes: '',
                } as any,
            };

            const timeline = buildTimeline(protoItem as Item);
            const commitEntries = timeline.filter(e => e.type === 'COMMIT');

            expect(commitEntries).toHaveLength(1);
            expect(commitEntries[0].authorLogin).toBe('dev-pair');
            expect(new Date(commitEntries[0].timestamp).getTime()).toBe(1700000900000);
        });
    });

    describe('CI Failure Summary and Detection', () => {
        it('identifies CI failures when bot comments report failure keywords', () => {
            const item: Partial<Item> = {
                id: 'owner/repo#1',
                repo: 'owner/repo',
                number: 1,
                type: ItemType.PR,
                title: 'Failing CI PR',
                state: ItemState.OPEN,
                url: 'https://github.com/owner/repo/pull/1',
                author: { login: 'dev', avatarUrl: '' } as any,
                comments: [
                    {
                        bodyText: 'Build and unit tests failed for commit abc1234. See log at https://ci.org/run/1',
                        author: { login: 'k8s-ci-robot[bot]' } as any,
                        createdAt: { seconds: BigInt(1700000100), nanos: 0 },
                        noiseType: CommentNoiseType.BOT_AUTHOR,
                        commentId: BigInt(1),
                    } as any,
                    {
                        bodyText: 'LGTM!',
                        author: { login: 'reviewer' } as any,
                        createdAt: { seconds: BigInt(1700000200), nanos: 0 },
                        commentId: BigInt(2),
                    } as any,
                ],
                commits: [],
                reviews: [],
            };

            const timeline = buildTimeline(item as Item);
            expect(hasCiFailures(timeline)).toBe(true);

            const summary = getCiFailureSummary(timeline);
            expect(summary.hasFailure).toBe(true);
            expect(summary.failureCount).toBe(1);
            expect(summary.failingAuthors).toContain('k8s-ci-robot[bot]');
            expect(summary.failedComments[0].bodyText).toContain('Build and unit tests failed');
            expect(summary.failedComments[0].url).toContain('#issuecomment-1');
        });

        it('returns hasFailure: false when all bot comments are successful', () => {
            const item: Partial<Item> = {
                id: 'owner/repo#2',
                repo: 'owner/repo',
                number: 2,
                type: ItemType.PR,
                title: 'Passing PR',
                state: ItemState.OPEN,
                url: 'https://github.com/owner/repo/pull/2',
                author: { login: 'dev', avatarUrl: '' } as any,
                comments: [
                    {
                        bodyText: 'All checks passed successfully.',
                        author: { login: 'github-actions[bot]' } as any,
                        createdAt: { seconds: BigInt(1700000100), nanos: 0 },
                        noiseType: CommentNoiseType.BOT_AUTHOR,
                        commentId: BigInt(2),
                    } as any,
                ],
                commits: [],
                reviews: [],
            };

            const timeline = buildTimeline(item as Item);
            expect(hasCiFailures(timeline)).toBe(false);

            const summary = getCiFailureSummary(timeline);
            expect(summary.hasFailure).toBe(false);
            expect(summary.failureCount).toBe(0);
            expect(summary.failedComments).toHaveLength(0);
        });
    });

    describe('getLatestRelevantActivity', () => {
        it('returns the most recent commit if it is after comments', () => {
            const timeline: TimelineEntry[] = [
                {
                    type: 'COMMENT',
                    data: {
                        bodyText: 'First comment',
                        author: { login: 'alice', avatarUrl: '' },
                    },
                    timestamp: '2026-08-01T10:00:00Z',
                },
                {
                    type: 'COMMIT',
                    authorLogin: 'bob',
                    timestamp: '2026-08-01T12:00:00Z',
                },
            ];

            const latest = getLatestRelevantActivity(timeline);
            expect(latest).not.toBeNull();
            expect(latest?.type).toBe('COMMIT');
            if (latest?.type === 'COMMIT') {
                expect(latest.authorLogin).toBe('bob');
            }
        });

        it('returns the most recent comment if it is after the condensed commit', () => {
            const timeline: TimelineEntry[] = [
                {
                    type: 'COMMIT',
                    authorLogin: 'bob',
                    timestamp: '2026-08-01T10:00:00Z',
                },
                {
                    type: 'COMMENT',
                    data: {
                        bodyText: 'Reviewed changes',
                        author: { login: 'alice', avatarUrl: '' },
                    },
                    timestamp: '2026-08-01T12:00:00Z',
                },
            ];

            const latest = getLatestRelevantActivity(timeline);
            expect(latest).not.toBeNull();
            expect(latest?.type).toBe('COMMENT');
            if (latest?.type === 'COMMENT') {
                expect(latest.data.author.login).toBe('alice');
            }
        });

        it('returns the review if it is the latest activity', () => {
            const timeline: TimelineEntry[] = [
                {
                    type: 'COMMENT',
                    data: {
                        bodyText: 'Please review',
                        author: { login: 'alice', avatarUrl: '' },
                    },
                    timestamp: '2026-08-01T10:00:00Z',
                },
                {
                    type: 'REVIEW',
                    author: { login: 'bob', avatarUrl: '' },
                    state: 'APPROVED',
                    timestamp: '2026-08-01T12:00:00Z',
                },
            ];

            const latest = getLatestRelevantActivity(timeline);
            expect(latest).not.toBeNull();
            expect(latest?.type).toBe('REVIEW');
            if (latest?.type === 'REVIEW') {
                expect(latest.author.login).toBe('bob');
                expect(latest.state).toBe('APPROVED');
            }
        });
    });

    describe('getLatestNonNoiseActivityMs', () => {
        it('returns timestamp of latest human comment when bot comment is newer', () => {
            const item: Partial<Item> = {
                createdAt: { seconds: BigInt(1700000000), nanos: 0 } as any,
                updatedAt: { seconds: BigInt(1700000900), nanos: 0 } as any,
                comments: [
                    {
                        commentId: BigInt(1),
                        bodyText: 'Human feedback',
                        author: { login: 'alice', avatarUrl: '' } as any,
                        createdAt: { seconds: BigInt(1700000500), nanos: 0 },
                        noiseType: 0,
                    } as any,
                    {
                        commentId: BigInt(2),
                        bodyText: 'Bot CI build succeeded',
                        author: { login: 'k8s-ci-robot', avatarUrl: '' } as any,
                        createdAt: { seconds: BigInt(1700000900), nanos: 0 },
                        noiseType: 1,
                    } as any,
                ],
                commits: [],
                reviews: [],
            };

            const ts = getLatestNonNoiseActivityMs(item as Item);
            expect(ts).toBe(1700000500000);
        });

        it('returns createdAt timestamp if all subsequent activity is bot noise', () => {
            const item: Partial<Item> = {
                createdAt: { seconds: BigInt(1700000000), nanos: 0 } as any,
                updatedAt: { seconds: BigInt(1700000900), nanos: 0 } as any,
                comments: [
                    {
                        commentId: BigInt(1),
                        bodyText: '/lgtm',
                        author: { login: 'bob', avatarUrl: '' } as any,
                        createdAt: { seconds: BigInt(1700000900), nanos: 0 },
                        noiseType: 2,
                    } as any,
                ],
                commits: [],
                reviews: [],
            };

            const ts = getLatestNonNoiseActivityMs(item as Item);
            expect(ts).toBe(1700000000000);
        });
    });

    describe('buildTimeline - review inclusion', () => {
        it('includes reviews in proto items', () => {
            const protoItem: Partial<Item> = {
                id: 'owner/repo#30',
                repo: 'owner/repo',
                number: 30,
                type: ItemType.PR,
                title: 'Review Test PR',
                state: ItemState.OPEN,
                url: 'https://github.com/owner/repo/pull/30',
                author: { login: 'dev', avatarUrl: '', type: 1 } as any,
                commits: [],
                comments: [],
                reviews: [
                    {
                        author: { login: 'reviewer1', avatarUrl: 'https://avatar1.url' } as any,
                        state: 'CHANGES_REQUESTED',
                        submittedAt: { seconds: BigInt(1700000500), nanos: 0 },
                        body: 'Please address these comments',
                        commentCount: 4,
                        url: 'https://github.com/owner/repo/pull/30#pullrequestreview-1',
                    } as any,
                ],
            };

            const timeline = buildTimeline(protoItem as Item);
            expect(timeline).toHaveLength(1);
            expect(timeline[0].type).toBe('REVIEW');
            if (timeline[0].type === 'REVIEW') {
                expect(timeline[0].author.login).toBe('reviewer1');
                expect(timeline[0].state).toBe('CHANGES_REQUESTED');
                expect(timeline[0].body).toBe('Please address these comments');
                expect(timeline[0].commentCount).toBe(4);
                expect(timeline[0].url).toBe('https://github.com/owner/repo/pull/30#pullrequestreview-1');
            }
        });
    });

    describe('buildTimeline - CommentNoiseType grouping', () => {
        it('correctly classifies proto comments by noiseType without needing client-side heuristics', () => {
            const protoItem: Partial<Item> = {
                id: 'owner/repo#20',
                repo: 'owner/repo',
                number: 20,
                type: ItemType.PR,
                title: 'Noise Classification PR',
                state: ItemState.OPEN,
                url: 'https://github.com/owner/repo/pull/20',
                author: { login: 'dev', avatarUrl: '', type: 1 } as any,
                commits: [],
                comments: [
                    {
                        commentId: BigInt(1),
                        bodyText: 'Regular human discussion',
                        author: { login: 'alice', avatarUrl: '' } as any,
                        createdAt: { seconds: BigInt(1700000100), nanos: 0 },
                        noiseType: 0, // UNSPECIFIED
                    } as any,
                    {
                        commentId: BigInt(2),
                        bodyText: 'Some text classified as bot author by backend',
                        author: { login: 'some-custom-bot-name', avatarUrl: '' } as any,
                        createdAt: { seconds: BigInt(1700000200), nanos: 0 },
                        noiseType: 1, // BOT_AUTHOR
                    } as any,
                    {
                        commentId: BigInt(3),
                        bodyText: '/some-custom-command',
                        author: { login: 'bob', avatarUrl: '' } as any,
                        createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                        noiseType: 2, // SLASH_COMMAND
                    } as any,
                    {
                        commentId: BigInt(4),
                        bodyText: 'Final human response',
                        author: { login: 'charlie', avatarUrl: '' } as any,
                        createdAt: { seconds: BigInt(1700000400), nanos: 0 },
                        noiseType: 0, // UNSPECIFIED
                    } as any,
                ],
                reviews: [],
                assignees: [],
                local: {
                    computedStatus: ItemStatus.NEW_ACTIVITY,
                    isAcked: false,
                    privateNotes: '',
                } as any,
            };

            const timeline = buildTimeline(protoItem as Item);
            expect(timeline).toHaveLength(3); // COMMENT, BOT_SUMMARY (collapsed 2 & 3), COMMENT
            expect(timeline[0].type).toBe('COMMENT');
            if (timeline[0].type === 'COMMENT') {
                expect(timeline[0].data.bodyText).toBe('Regular human discussion');
            }

            expect(timeline[1].type).toBe('BOT_SUMMARY');
            if (timeline[1].type === 'BOT_SUMMARY') {
                expect(timeline[1].count).toBe(2);
                expect(timeline[1].comments).toHaveLength(2);
            }

            expect(timeline[2].type).toBe('COMMENT');
            if (timeline[2].type === 'COMMENT') {
                expect(timeline[2].data.bodyText).toBe('Final human response');
            }
        });
    });

    describe('buildTimeline - state changes (merged, closed, reopened)', () => {
        it('includes state events from item.stateEvents chronologically', () => {
            const item: Partial<Item> = {
                id: 'owner/repo#50',
                repo: 'owner/repo',
                number: 50,
                type: ItemType.PR,
                title: 'State PR',
                state: ItemState.MERGED,
                url: 'https://github.com/owner/repo/pull/50',
                author: { login: 'dev', avatarUrl: '' } as any,
                commits: [
                    { authorLogin: 'dev', committedDate: { seconds: BigInt(1700000100), nanos: 0 } } as any,
                ],
                comments: [
                    {
                        commentId: BigInt(1),
                        bodyText: 'Looking good!',
                        author: { login: 'reviewer', avatarUrl: '' } as any,
                        createdAt: { seconds: BigInt(1700000200), nanos: 0 },
                    } as any,
                ],
                reviews: [],
                stateEvents: [
                    {
                        type: 1, // CLOSED
                        createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                        actor: { login: 'closer', avatarUrl: 'https://closer.url' } as any,
                        url: 'https://github.com/owner/repo/pull/50#event-1',
                    } as any,
                    {
                        type: 3, // REOPENED
                        createdAt: { seconds: BigInt(1700000400), nanos: 0 },
                        actor: { login: 'reopener', avatarUrl: 'https://reopener.url' } as any,
                    } as any,
                    {
                        type: 2, // MERGED
                        createdAt: { seconds: BigInt(1700000500), nanos: 0 },
                        actor: { login: 'merger', avatarUrl: 'https://merger.url' } as any,
                        url: 'https://github.com/owner/repo/pull/50#event-2',
                    } as any,
                ],
            };

            const timeline = buildTimeline(item as Item);
            expect(timeline).toHaveLength(5); // COMMIT, COMMENT, STATE_CHANGE(CLOSED), STATE_CHANGE(REOPENED), STATE_CHANGE(MERGED)
            expect(timeline[0].type).toBe('COMMIT');
            expect(timeline[1].type).toBe('COMMENT');
            expect(timeline[2].type).toBe('STATE_CHANGE');
            expect(timeline[3].type).toBe('STATE_CHANGE');
            expect(timeline[4].type).toBe('STATE_CHANGE');

            const closed = timeline[2] as any;
            expect(closed.changeType).toBe('CLOSED');
            expect(closed.actor.login).toBe('closer');
            expect(closed.url).toBe('https://github.com/owner/repo/pull/50#event-1');

            const reopened = timeline[3] as any;
            expect(reopened.changeType).toBe('REOPENED');
            expect(reopened.actor.login).toBe('reopener');

            const merged = timeline[4] as any;
            expect(merged.changeType).toBe('MERGED');
            expect(merged.actor.login).toBe('merger');
            expect(merged.url).toBe('https://github.com/owner/repo/pull/50#event-2');
        });

        it('suppresses CLOSED state events occurring at or after MERGED events', () => {
            const mergedItemWithClose: Partial<Item> = {
                id: 'owner/repo#55',
                repo: 'owner/repo',
                number: 55,
                type: ItemType.PR,
                title: 'Merged PR with duplicate close',
                state: ItemState.MERGED,
                url: 'https://github.com/owner/repo/pull/55',
                commits: [],
                comments: [],
                reviews: [],
                stateEvents: [
                    {
                        type: 2, // MERGED
                        createdAt: { seconds: BigInt(1700000500), nanos: 0 },
                        actor: { login: 'merger', avatarUrl: 'https://merger.url' } as any,
                        url: 'https://github.com/owner/repo/pull/55#event-merge',
                    } as any,
                    {
                        type: 1, // CLOSED (emitted by GitHub upon merge)
                        createdAt: { seconds: BigInt(1700000500), nanos: 0 },
                        actor: { login: 'merger', avatarUrl: 'https://merger.url' } as any,
                        url: 'https://github.com/owner/repo/pull/55#event-close',
                    } as any,
                ],
            };

            const timeline = buildTimeline(mergedItemWithClose as Item);
            expect(timeline).toHaveLength(1);
            expect(timeline[0].type).toBe('STATE_CHANGE');
            const entry = timeline[0] as any;
            expect(entry.changeType).toBe('MERGED');
            expect(entry.actor.login).toBe('merger');
        });

        it('preserves earlier CLOSED events if PR was closed/reopened before being merged', () => {
            const item: Partial<Item> = {
                id: 'owner/repo#56',
                repo: 'owner/repo',
                number: 56,
                type: ItemType.PR,
                title: 'Closed, Reopened, and Merged PR',
                state: ItemState.MERGED,
                url: 'https://github.com/owner/repo/pull/56',
                commits: [],
                comments: [],
                reviews: [],
                stateEvents: [
                    {
                        type: 1, // CLOSED (earlier)
                        createdAt: { seconds: BigInt(1700000100), nanos: 0 },
                        actor: { login: 'closer', avatarUrl: '' } as any,
                    } as any,
                    {
                        type: 3, // REOPENED
                        createdAt: { seconds: BigInt(1700000200), nanos: 0 },
                        actor: { login: 'reopener', avatarUrl: '' } as any,
                    } as any,
                    {
                        type: 2, // MERGED
                        createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                        actor: { login: 'merger', avatarUrl: '' } as any,
                    } as any,
                    {
                        type: 1, // CLOSED (duplicate from merge)
                        createdAt: { seconds: BigInt(1700000301), nanos: 0 },
                        actor: { login: 'merger', avatarUrl: '' } as any,
                    } as any,
                ],
            };

            const timeline = buildTimeline(item as Item);
            expect(timeline).toHaveLength(3); // CLOSED, REOPENED, MERGED (duplicate close at 1700000301 suppressed)
            expect((timeline[0] as any).changeType).toBe('CLOSED');
            expect((timeline[1] as any).changeType).toBe('REOPENED');
            expect((timeline[2] as any).changeType).toBe('MERGED');
        });

        it('synthesizes fallback state change for MERGED and CLOSED items without stateEvents', () => {
            const mergedItem: Partial<Item> = {
                id: 'owner/repo#51',
                repo: 'owner/repo',
                number: 51,
                type: ItemType.PR,
                title: 'Merged PR without events',
                state: ItemState.MERGED,
                updatedAt: { seconds: BigInt(1700000999), nanos: 0 } as any,
                url: 'https://github.com/owner/repo/pull/51',
                comments: [],
                commits: [],
                reviews: [],
                stateEvents: [],
            };

            const timeline = buildTimeline(mergedItem as Item);
            expect(timeline).toHaveLength(1);
            expect(timeline[0].type).toBe('STATE_CHANGE');
            const entry = timeline[0] as any;
            expect(entry.changeType).toBe('MERGED');

            const latest = getLatestRelevantActivity(timeline);
            expect(latest).not.toBeNull();
            expect(latest?.type).toBe('STATE_CHANGE');
        });

        it('includes ASSIGNED state change events from item.stateEvents', () => {
            const item: Partial<Item> = {
                id: 'owner/repo#52',
                repo: 'owner/repo',
                number: 52,
                type: ItemType.PR,
                title: 'Assigned PR',
                state: ItemState.OPEN,
                url: 'https://github.com/owner/repo/pull/52',
                author: { login: 'author', avatarUrl: '' } as any,
                commits: [],
                comments: [],
                reviews: [],
                stateEvents: [
                    {
                        type: 4, // ASSIGNED
                        createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                        actor: { login: 'assigner', avatarUrl: 'https://avatar.url' } as any,
                        url: 'https://github.com/owner/repo/pull/52#event-assigned',
                    } as any,
                ],
            };

            const timeline = buildTimeline(item as Item);
            expect(timeline).toHaveLength(1);
            expect(timeline[0].type).toBe('STATE_CHANGE');
            const entry = timeline[0] as any;
            expect(entry.changeType).toBe('ASSIGNED');
            expect(entry.actor.login).toBe('assigner');
            expect(entry.url).toBe('https://github.com/owner/repo/pull/52#event-assigned');

            const latest = getLatestRelevantActivity(timeline);
            expect(latest).not.toBeNull();
            expect(latest?.type).toBe('STATE_CHANGE');
            if (latest?.type === 'STATE_CHANGE') {
                expect(latest.changeType).toBe('ASSIGNED');
            }
        });
    });

    describe('formatReviewCommentSummary', () => {
        it('formats new threads and replies correctly', () => {
            expect(formatReviewCommentSummary({ newThreadsCount: 4, replyCount: 1 })).toBe('4 comments, 1 reply');
            expect(formatReviewCommentSummary({ newThreadsCount: 5, replyCount: 0 })).toBe('5 comments');
            expect(formatReviewCommentSummary({ newThreadsCount: 0, replyCount: 3 })).toBe('3 replies');
            expect(formatReviewCommentSummary({ commentCount: 2 })).toBe('2 comments');
            expect(formatReviewCommentSummary({})).toBe('');
        });
    });

    describe('getFilesViewUrl', () => {
        it('converts pull request comment URLs to open in files changes view', () => {
            expect(getFilesViewUrl('https://github.com/kubernetes/enhancements/pull/6169#discussion_r3639856644'))
                .toBe('https://github.com/kubernetes/enhancements/pull/6169/files#r3639856644');
            expect(getFilesViewUrl('https://github.com/kubernetes/enhancements/pull/6169/changes#discussion_r3639856644'))
                .toBe('https://github.com/kubernetes/enhancements/pull/6169/changes#r3639856644');
            expect(getFilesViewUrl('https://github.com/owner/repo/pull/123/files#r456'))
                .toBe('https://github.com/owner/repo/pull/123/files#r456');
            expect(getFilesViewUrl(undefined)).toBeUndefined();
        });
    });

    describe('getThreadContext', () => {
        it('returns root and prior replies in chronological order and excludes later replies', () => {
            const item: Partial<Item> = {
                id: 'owner/repo#90',
                reviews: [
                    {
                        author: { login: 'alice', avatarUrl: 'https://alice.png' } as any,
                        submittedAt: { seconds: BigInt(1700000100), nanos: 0 },
                        comments: [
                            {
                                id: 'c_root',
                                body: 'Root comment on line 10',
                                path: 'pkg/foo.go',
                                url: 'https://github.com/owner/repo/pull/90#discussion_r1',
                                createdAt: { seconds: BigInt(1700000100), nanos: 0 },
                            },
                            {
                                id: 'c_unrelated',
                                body: 'Other thread root',
                                path: 'pkg/bar.go',
                                createdAt: { seconds: BigInt(1700000150), nanos: 0 },
                            },
                        ],
                    } as any,
                    {
                        author: { login: 'bob', avatarUrl: 'https://bob.png' } as any,
                        submittedAt: { seconds: BigInt(1700000200), nanos: 0 },
                        comments: [
                            {
                                id: 'c_reply1',
                                body: 'First reply',
                                path: 'pkg/foo.go',
                                url: 'https://github.com/owner/repo/pull/90#discussion_r2',
                                replyToId: 'c_root',
                                createdAt: { seconds: BigInt(1700000200), nanos: 0 },
                            },
                        ],
                    } as any,
                    {
                        author: { login: 'alice', avatarUrl: 'https://alice.png' } as any,
                        submittedAt: { seconds: BigInt(1700000300), nanos: 0 },
                        comments: [
                            {
                                id: 'c_reply2',
                                body: 'Second reply (target)',
                                path: 'pkg/foo.go',
                                url: 'https://github.com/owner/repo/pull/90#discussion_r3',
                                replyToId: 'c_root',
                                createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                            },
                            {
                                id: 'c_reply3_later',
                                body: 'Later reply after target',
                                path: 'pkg/foo.go',
                                url: 'https://github.com/owner/repo/pull/90#discussion_r4',
                                replyToId: 'c_root',
                                createdAt: { seconds: BigInt(1700000400), nanos: 0 },
                            },
                        ],
                    } as any,
                ],
            };

            const timeline = buildTimeline(item as Item);
            const reviewEntries = timeline.filter(e => e.type === 'REVIEW') as any[];
            const targetComment = reviewEntries[2].comments[0];

            const ctx = getThreadContext(item as Item, targetComment);
            expect(ctx.rootMissing).toBe(false);
            expect(ctx.comments.map(c => c.id)).toEqual(['c_root', 'c_reply1']);
            expect(ctx.comments[0].author?.login).toBe('alice');
            expect(ctx.comments[1].author?.login).toBe('bob');
        });

        it('sets rootMissing to true when no comment in item.reviews has id === threadId', () => {
            const item: Partial<Item> = {
                id: 'owner/repo#91',
                reviews: [
                    {
                        author: { login: 'bob', avatarUrl: '' } as any,
                        submittedAt: { seconds: BigInt(1700000200), nanos: 0 },
                        comments: [
                            {
                                id: 'c_reply1',
                                body: 'Prior reply with missing root',
                                replyToId: 'c_missing_root',
                                createdAt: { seconds: BigInt(1700000200), nanos: 0 },
                            },
                            {
                                id: 'c_reply2',
                                body: 'Target reply with missing root',
                                replyToId: 'c_missing_root',
                                createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                            },
                        ],
                    } as any,
                ],
            };

            const timeline = buildTimeline(item as Item);
            const reviewEntry = timeline.find(e => e.type === 'REVIEW') as any;
            const targetComment = reviewEntry.comments[1];

            const ctx = getThreadContext(item as Item, targetComment);
            expect(ctx.rootMissing).toBe(true);
            expect(ctx.comments.map(c => c.id)).toEqual(['c_reply1']);
        });

        it('breaks timestamp ties by fetch order', () => {
            const sameTs = { seconds: BigInt(1700000500), nanos: 0 };
            const item: Partial<Item> = {
                id: 'owner/repo#92',
                reviews: [
                    {
                        author: { login: 'alice', avatarUrl: '' } as any,
                        submittedAt: sameTs,
                        comments: [
                            { id: 'c1', body: 'Root', createdAt: sameTs },
                            { id: 'c2', body: 'Reply 1 same ts', replyToId: 'c1', createdAt: sameTs },
                            { id: 'c3', body: 'Reply 2 same ts', replyToId: 'c1', createdAt: sameTs },
                            { id: 'c4', body: 'Reply 3 same ts (after c3)', replyToId: 'c1', createdAt: sameTs },
                        ],
                    } as any,
                ],
            };

            const timeline = buildTimeline(item as Item);
            const reviewEntry = timeline.find(e => e.type === 'REVIEW') as any;
            const c3 = reviewEntry.comments[2];

            const ctx = getThreadContext(item as Item, c3);
            expect(ctx.rootMissing).toBe(false);
            expect(ctx.comments.map(c => c.id)).toEqual(['c1', 'c2']);
        });

        it('returns partial prior replies and rootMissing: true when root and earlier intermediate replies were pruned by backfill cap', () => {
            const item: Partial<Item> = {
                id: 'owner/repo#93',
                reviews: [
                    {
                        author: { login: 'charlie', avatarUrl: '' } as any,
                        submittedAt: { seconds: BigInt(1700000300), nanos: 0 },
                        comments: [
                            {
                                id: 'c_reply_kept_1',
                                body: 'Intermediate reply 2 after cap',
                                replyToId: 'c_pruned_root',
                                createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                            },
                        ],
                    } as any,
                    {
                        author: { login: 'dave', avatarUrl: '' } as any,
                        submittedAt: { seconds: BigInt(1700000400), nanos: 0 },
                        comments: [
                            {
                                id: 'c_reply_kept_2',
                                body: 'Intermediate reply 3 after cap',
                                replyToId: 'c_pruned_root',
                                createdAt: { seconds: BigInt(1700000400), nanos: 0 },
                            },
                        ],
                    } as any,
                    {
                        author: { login: 'eve', avatarUrl: '' } as any,
                        submittedAt: { seconds: BigInt(1700000500), nanos: 0 },
                        comments: [
                            {
                                id: 'c_reply_target',
                                body: 'Target reply in pruned thread',
                                replyToId: 'c_pruned_root',
                                createdAt: { seconds: BigInt(1700000500), nanos: 0 },
                            },
                            {
                                id: 'c_reply_after_target',
                                body: 'Reply after target',
                                replyToId: 'c_pruned_root',
                                createdAt: { seconds: BigInt(1700000600), nanos: 0 },
                            },
                        ],
                    } as any,
                ],
            };

            const timeline = buildTimeline(item as Item);
            const reviewEntries = timeline.filter(e => e.type === 'REVIEW') as any[];
            const target = reviewEntries[2].comments[0];

            const ctx = getThreadContext(item as Item, target);
            expect(ctx.rootMissing).toBe(true);
            expect(ctx.comments.map(c => c.id)).toEqual(['c_reply_kept_1', 'c_reply_kept_2']);
        });

        it('orders comments by fetch order without fabricating timestamps when createdAt is missing on multiple comments', () => {
            const item: Partial<Item> = {
                id: 'owner/repo#94',
                reviews: [
                    {
                        author: { login: 'alice', avatarUrl: '' } as any,
                        submittedAt: { seconds: BigInt(1700000100), nanos: 0 },
                        comments: [
                            { id: 'c_root_no_ts', body: 'Root without createdAt' },
                            { id: 'c_reply1_no_ts', body: 'Reply 1 without createdAt', replyToId: 'c_root_no_ts' },
                        ],
                    } as any,
                    {
                        author: { login: 'bob', avatarUrl: '' } as any,
                        submittedAt: { seconds: BigInt(1700000200), nanos: 0 },
                        comments: [
                            { id: 'c_reply2_no_ts', body: 'Reply 2 without createdAt', replyToId: 'c_root_no_ts' },
                            { id: 'c_reply3_no_ts', body: 'Reply 3 after target', replyToId: 'c_root_no_ts' },
                        ],
                    } as any,
                ],
            };

            const timeline = buildTimeline(item as Item);
            const reviewEntries = timeline.filter(e => e.type === 'REVIEW') as any[];
            const target = reviewEntries[1].comments[0];

            const ctx = getThreadContext(item as Item, target);
            expect(ctx.rootMissing).toBe(false);
            expect(ctx.comments.map(c => c.id)).toEqual(['c_root_no_ts', 'c_reply1_no_ts']);
            expect(ctx.comments[0].createdAt).toBeUndefined();
            expect(ctx.comments[1].createdAt).toBeUndefined();
        });

        it('keeps thread root and sets rootMissing: false even when root appears in a later review with tied or missing createdAt', () => {
            const sameTs = { seconds: BigInt(1700000500), nanos: 0 };
            const item: Partial<Item> = {
                id: 'owner/repo#95',
                reviews: [
                    {
                        author: { login: 'bob', avatarUrl: '' } as any,
                        submittedAt: sameTs,
                        comments: [
                            { id: 'c_reply_target', body: 'Target reply', replyToId: 'c_root', createdAt: sameTs },
                        ],
                    } as any,
                    {
                        author: { login: 'alice', avatarUrl: '' } as any,
                        submittedAt: sameTs,
                        comments: [
                            { id: 'c_root', body: 'Root in later review', createdAt: sameTs },
                        ],
                    } as any,
                ],
            };

            const timeline = buildTimeline(item as Item);
            const reviewEntries = timeline.filter(e => e.type === 'REVIEW') as any[];
            const target = reviewEntries[0].comments[0];

            const ctx = getThreadContext(item as Item, target);
            expect(ctx.rootMissing).toBe(false);
            expect(ctx.comments.map(c => c.id)).toEqual(['c_root']);
        });

        it('sorts a target with missing createdAt after timestamped replies instead of inheriting an earlier timestamp', () => {
            const item: Partial<Item> = {
                id: 'owner/repo#96',
                reviews: [
                    {
                        author: { login: 'alice', avatarUrl: '' } as any,
                        submittedAt: { seconds: BigInt(1700000100), nanos: 0 },
                        comments: [
                            {
                                id: 'c_root',
                                body: 'Root at t=100',
                                createdAt: { seconds: BigInt(1700000100), nanos: 0 },
                            },
                            {
                                id: 'c_target',
                                body: 'Target reply',
                                replyToId: 'c_root',
                            },
                            {
                                id: 'c_post_target',
                                body: 'Post-target reply with earlier timestamp than c_root if c_target inherited t=100',
                                replyToId: 'c_root',
                                createdAt: { seconds: BigInt(1700000050), nanos: 0 },
                            },
                        ],
                    } as any,
                ],
            };

            const timeline = buildTimeline(item as Item);
            const reviewEntries = timeline.filter(e => e.type === 'REVIEW') as any[];
            const target = reviewEntries[0].comments[1];

            const ctx = getThreadContext(item as Item, target);
            expect(ctx.rootMissing).toBe(false);
            // Missing timestamps sort as +Infinity, so the timestamped reply precedes the target.
            expect(ctx.comments.map(c => c.id)).toEqual(['c_root', 'c_post_target']);
            expect(ctx.comments[1].createdAt).toBe(new Date(1700000050 * 1000).toISOString());
        });

        it('uses a total order: root first, then timestamp with missing timestamps last, then fetch order', () => {
            const item: Partial<Item> = {
                id: 'owner/repo#97',
                reviews: [
                    {
                        author: { login: 'alice', avatarUrl: '' } as any,
                        submittedAt: { seconds: BigInt(1700000100), nanos: 0 },
                        comments: [
                            { id: 'c_no_ts_1', body: 'Reply without createdAt', replyToId: 'c_root' },
                            {
                                id: 'c_ts_200',
                                body: 'Reply at t=200',
                                replyToId: 'c_root',
                                createdAt: { seconds: BigInt(1700000200), nanos: 0 },
                            },
                            { id: 'c_no_ts_2', body: 'Another reply without createdAt', replyToId: 'c_root' },
                            {
                                id: 'c_root',
                                body: 'Root fetched last at t=300',
                                createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                            },
                            { id: 'c_target', body: 'Target without createdAt', replyToId: 'c_root' },
                        ],
                    } as any,
                ],
            };

            const timeline = buildTimeline(item as Item);
            const reviewEntry = timeline.find(e => e.type === 'REVIEW') as any;
            const target = reviewEntry.comments[4];

            const ctx = getThreadContext(item as Item, target);
            expect(ctx.rootMissing).toBe(false);
            expect(ctx.comments.map(c => c.id)).toEqual(['c_root', 'c_ts_200', 'c_no_ts_1', 'c_no_ts_2']);
        });

        it('identifies the target comment by id only, never by matching body text', () => {
            const ts = { seconds: BigInt(1700000300), nanos: 0 };
            const item: Partial<Item> = {
                id: 'owner/repo#98',
                reviews: [
                    {
                        author: { login: 'alice', avatarUrl: '' } as any,
                        submittedAt: ts,
                        comments: [
                            { id: 'c_root', body: 'Root', createdAt: { seconds: BigInt(1700000100), nanos: 0 } },
                            { id: 'c_same_body', body: '+1', replyToId: 'c_root', createdAt: ts },
                        ],
                    } as any,
                ],
            };

            // A comment without an id whose body matches c_same_body must not be conflated with it.
            const ctx = getThreadContext(item as Item, {
                id: '',
                body: '+1',
                replyToId: 'c_root',
                createdAt: new Date(1700000300 * 1000).toISOString(),
            });
            expect(ctx.comments.map(c => c.id)).toEqual(['c_root', 'c_same_body']);
        });
    });
});

