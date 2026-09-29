/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DetailsPane } from '../DetailsPane';
import { describe, it, expect, vi } from 'vitest';
import type { Item, User } from '../../api/octodeck/v1/resources_pb';
import { ItemType, ItemState, ItemStatus, CommentNoiseType, SubscriptionState } from '../../api/octodeck/v1/resources_pb';

const mockItemWithBody: Partial<Item> = {
    id: 'PR_1',
    repo: 'owner/repo',
    number: 123,
    type: ItemType.PR,
    title: 'Test PR with Description',
    body: '## PR Overview\nThis PR implements markdown descriptions.',
    state: ItemState.OPEN,
    url: 'https://github.com/owner/repo/pull/123',
    author: { login: 'octouser', avatarUrl: 'https://avatar.url' } as User,
    commits: [],
    comments: [],
    reviews: [],
    assignees: [],
    local: {
        computedStatus: ItemStatus.NEW,
        privateNotes: '',
    } as unknown as NonNullable<Item['local']>,
};

const mockProtoItemWithBody: Partial<Item> = {
    id: 'owner/repo#456',
    repo: 'owner/repo',
    number: 456,
    type: ItemType.PR,
    title: 'Proto PR Test',
    body: '### Motivation\nAddresses #100 with comprehensive tests.',
    state: ItemState.OPEN,
    url: 'https://github.com/owner/repo/pull/456',
    author: { login: 'protoDev', avatarUrl: 'https://avatar.url', type: 1 } as unknown as User,
    commits: [],
    comments: [],
    reviews: [],
    assignees: [],
    local: {
        computedStatus: ItemStatus.NEW_ACTIVITY,
        isAcked: false,
        privateNotes: '',
    } as unknown as NonNullable<Item['local']>,
};

describe('DetailsPane Component', () => {
    it('renders description section when body is present in legacy item', () => {
        render(
            <DetailsPane
                item={mockItemWithBody as Item}
                onAck={vi.fn()}
                onUnack={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const heading = screen.getByRole('heading', { level: 2 });
        expect(heading.textContent).toBe('PR Overview');
        expect(screen.getByText('This PR implements markdown descriptions.')).toBeDefined();
    });

    it('renders description section when body is present in Proto Item', () => {
        render(
            <DetailsPane
                item={mockProtoItemWithBody as Item}
                onAck={vi.fn()}
                onUnack={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const heading = screen.getByRole('heading', { level: 3 });
        expect(heading.textContent).toBe('Motivation');
        expect(screen.getByText(/Addresses #100 with comprehensive tests/)).toBeDefined();
    });

    it('omits description section when body is empty or whitespace', () => {
        const itemWithoutBody: Partial<Item> = {
            ...mockItemWithBody,
            id: 'PR_2',
            body: '   ',
        };

        render(
            <DetailsPane
                item={itemWithoutBody as Item}
                onAck={vi.fn()}
                onUnack={vi.fn()}
                onClose={vi.fn()}
            />
        );

        expect(screen.queryByText('Description')).toBeNull();
    });

    it('does not render item ID in header when showItemId is false or omitted', () => {
        render(
            <DetailsPane
                item={mockItemWithBody as Item}
                onAck={vi.fn()}
                onUnack={vi.fn()}
                onClose={vi.fn()}
            />
        );

        expect(screen.queryByText(/ID: PR_1/)).toBeNull();
    });

    it('renders item ID in header when showItemId is true', () => {
        render(
            <DetailsPane
                item={mockItemWithBody as Item}
                onAck={vi.fn()}
                onUnack={vi.fn()}
                onClose={vi.fn()}
                showItemId={true}
            />
        );

        expect(screen.getByText('ID: PR_1')).toBeDefined();
    });

    it('renders item ID for Protobuf Item when showItemId is true', () => {
        render(
            <DetailsPane
                item={mockProtoItemWithBody as Item}
                onAck={vi.fn()}
                onUnack={vi.fn()}
                onClose={vi.fn()}
                showItemId={true}
            />
        );

        expect(screen.getByText('ID: owner/repo#456')).toBeDefined();
    });

    it('calls onOpenDebug with item id when clicking item ID', () => {
        const onOpenDebug = vi.fn();
        render(
            <DetailsPane
                item={mockItemWithBody as Item}
                onAck={vi.fn()}
                onUnack={vi.fn()}
                onClose={vi.fn()}
                showItemId={true}
                onOpenDebug={onOpenDebug}
            />
        );

        const idElement = screen.getByText('ID: PR_1');
        fireEvent.click(idElement);

        expect(onOpenDebug).toHaveBeenCalledWith('PR_1');
    });

    it('renders View Changes link with /files for pull requests', () => {
        render(
            <DetailsPane
                item={mockItemWithBody as Item}
                onAck={vi.fn()}
                onUnack={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const viewChangesBtn = screen.getByTitle('View Changes on GitHub');
        expect(viewChangesBtn).toBeDefined();
        expect(viewChangesBtn.getAttribute('href')).toBe('https://github.com/owner/repo/pull/123/files');
        expect(viewChangesBtn.textContent).toContain('View Changes');
    });

    it('renders full-width title link pointing to GitHub with Open on GitHub title', () => {
        render(
            <DetailsPane
                item={mockProtoItemWithBody as Item}
                onAck={vi.fn()}
                onUnack={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const titleLink = screen.getByTitle('Open on GitHub');
        expect(titleLink).toBeDefined();
        expect(titleLink.getAttribute('href')).toBe('https://github.com/owner/repo/pull/456');
        expect(titleLink.getAttribute('target')).toBe('_blank');
        expect(titleLink.textContent).toContain('Proto PR Test');
    });

    it('omits View Changes link for issues', () => {
        const issueItem: Partial<Item> = {
            ...mockProtoItemWithBody,
            id: 'owner/repo#789',
            type: ItemType.ISSUE,
            url: 'https://github.com/owner/repo/issues/789',
        };

        render(
            <DetailsPane
                item={issueItem as Item}
                onAck={vi.fn()}
                onUnack={vi.fn()}
                onClose={vi.fn()}
            />
        );

        expect(screen.queryByTitle('View Changes on GitHub')).toBeNull();
    });

    describe('Collapsible Private Notes', () => {
        it('is collapsed by default when private notes are empty', () => {
            render(
                <DetailsPane
                    item={mockProtoItemWithBody as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('Private Notes (Local Only)')).toBeDefined();
            expect(screen.getByText('Click to add notes')).toBeDefined();
            expect(screen.queryByPlaceholderText('Jot down context, todos, or reminders...')).toBeNull();
        });

        it('expands when clicking the toggle header and displays textarea', () => {
            render(
                <DetailsPane
                    item={mockProtoItemWithBody as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            const toggleBtn = screen.getByRole('button', { name: /Private Notes/i });
            fireEvent.click(toggleBtn);

            const textarea = screen.getByPlaceholderText('Jot down context, todos, or reminders...');
            expect(textarea).toBeDefined();
        });

        it('is expanded by default when initial private notes exist', () => {
            const itemWithNotes: Partial<Item> = {
                ...mockProtoItemWithBody,
                local: {
                    ...mockProtoItemWithBody.local,
                    privateNotes: 'Existing note for this PR',
                } as any,
            };

            render(
                <DetailsPane
                    item={itemWithNotes as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('Private Notes (Local Only)')).toBeDefined();
            const textarea = screen.getByPlaceholderText('Jot down context, todos, or reminders...') as HTMLTextAreaElement;
            expect(textarea).toBeDefined();
            expect(textarea.value).toBe('Existing note for this PR');
        });

        it('triggers onSetNotes on blur when notes content has changed', () => {
            const onSetNotes = vi.fn();
            render(
                <DetailsPane
                    item={mockProtoItemWithBody as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onSetNotes={onSetNotes}
                    onClose={vi.fn()}
                />
            );

            // Expand notes
            const toggleBtn = screen.getByRole('button', { name: /Private Notes/i });
            fireEvent.click(toggleBtn);

            const textarea = screen.getByPlaceholderText('Jot down context, todos, or reminders...');
            fireEvent.change(textarea, { target: { value: 'Follow up tomorrow' } });
            fireEvent.blur(textarea);

            expect(onSetNotes).toHaveBeenCalledWith('owner/repo#456', 'Follow up tomorrow');
        });

        it('triggers onSetNotes on Cmd+Enter shortcut', () => {
            const onSetNotes = vi.fn();
            render(
                <DetailsPane
                    item={mockProtoItemWithBody as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onSetNotes={onSetNotes}
                    onClose={vi.fn()}
                />
            );

            // Expand notes
            const toggleBtn = screen.getByRole('button', { name: /Private Notes/i });
            fireEvent.click(toggleBtn);

            const textarea = screen.getByPlaceholderText('Jot down context, todos, or reminders...');
            fireEvent.change(textarea, { target: { value: 'Quick note' } });
            fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

            expect(onSetNotes).toHaveBeenCalledWith('owner/repo#456', 'Quick note');
        });
    });

    describe('Timeline and Consolidated CI Failure Badge', () => {
        it('renders New Activity Since Last View divider based on lastViewedAt', () => {
            const item: Partial<Item> = {
                ...mockProtoItemWithBody,
                comments: [
                    {
                        author: { login: 'alice', avatarUrl: '', type: 1 },
                        bodyText: 'First comment before last view',
                        createdAt: { seconds: BigInt(1700000100), nanos: 0 },
                        commentId: BigInt(1),
                        noiseType: CommentNoiseType.UNSPECIFIED,
                    } as any,
                    {
                        author: { login: 'bob', avatarUrl: '', type: 1 },
                        bodyText: 'Second comment after last view',
                        createdAt: { seconds: BigInt(1700000900), nanos: 0 },
                        commentId: BigInt(2),
                        noiseType: CommentNoiseType.UNSPECIFIED,
                    } as any,
                ],
                local: {
                    ...mockProtoItemWithBody.local,
                    lastViewedAt: { seconds: BigInt(1700000500), nanos: 0 },
                } as any,
            };

            render(
                <DetailsPane
                    item={item as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('Last Viewed')).toBeDefined();
            expect(screen.queryByText('Acknowledged')).toBeNull();
        });

        it('renders Acknowledged divider based on ackedAt', () => {
            const item: Partial<Item> = {
                ...mockProtoItemWithBody,
                comments: [
                    {
                        author: { login: 'alice', avatarUrl: '', type: 1 },
                        bodyText: 'Comment after last ack',
                        createdAt: { seconds: BigInt(1700000900), nanos: 0 },
                        commentId: BigInt(1),
                        noiseType: CommentNoiseType.UNSPECIFIED,
                    } as any,
                ],
                local: {
                    ...mockProtoItemWithBody.local,
                    ackedAt: { seconds: BigInt(1700000500), nanos: 0 },
                } as any,
            };

            render(
                <DetailsPane
                    item={item as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('Acknowledged')).toBeDefined();
            expect(screen.queryByText('Last Viewed')).toBeNull();
        });

        it('renders Acknowledged divider at end of timeline when there is no activity after ackedAt', () => {
            const item: Partial<Item> = {
                ...mockProtoItemWithBody,
                comments: [
                    {
                        author: { login: 'alice', avatarUrl: '', type: 1 },
                        bodyText: 'Comment before last ack',
                        createdAt: { seconds: BigInt(1700000100), nanos: 0 },
                        commentId: BigInt(1),
                        noiseType: CommentNoiseType.UNSPECIFIED,
                    } as any,
                ],
                local: {
                    ...mockProtoItemWithBody.local,
                    ackedAt: { seconds: BigInt(1700000500), nanos: 0 },
                } as any,
            };

            render(
                <DetailsPane
                    item={item as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('Acknowledged')).toBeDefined();
            expect(screen.queryByText('Last Viewed')).toBeNull();
        });

        it('suppresses Last Viewed divider when Acknowledged and Last Viewed would be adjacent', () => {
            const item: Partial<Item> = {
                ...mockProtoItemWithBody,
                comments: [
                    {
                        author: { login: 'alice', avatarUrl: '', type: 1 },
                        bodyText: 'Comment after both view and ack',
                        createdAt: { seconds: BigInt(1700000900), nanos: 0 },
                        commentId: BigInt(1),
                        noiseType: CommentNoiseType.UNSPECIFIED,
                    } as any,
                ],
                local: {
                    ...mockProtoItemWithBody.local,
                    lastViewedAt: { seconds: BigInt(1700000500), nanos: 0 },
                    ackedAt: { seconds: BigInt(1700000500), nanos: 0 },
                } as any,
            };

            render(
                <DetailsPane
                    item={item as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('Acknowledged')).toBeDefined();
            expect(screen.queryByText('Last Viewed')).toBeNull();
        });

        it('renders both Last Viewed and Acknowledged when there is activity in between them', () => {
            const item: Partial<Item> = {
                ...mockProtoItemWithBody,
                comments: [
                    {
                        author: { login: 'alice', avatarUrl: '', type: 1 },
                        bodyText: 'Comment between view and ack',
                        createdAt: { seconds: BigInt(1700000500), nanos: 0 },
                        commentId: BigInt(1),
                        noiseType: CommentNoiseType.UNSPECIFIED,
                    } as any,
                    {
                        author: { login: 'bob', avatarUrl: '', type: 1 },
                        bodyText: 'Comment after ack',
                        createdAt: { seconds: BigInt(1700000900), nanos: 0 },
                        commentId: BigInt(2),
                        noiseType: CommentNoiseType.UNSPECIFIED,
                    } as any,
                ],
                local: {
                    ...mockProtoItemWithBody.local,
                    lastViewedAt: { seconds: BigInt(1700000100), nanos: 0 },
                    ackedAt: { seconds: BigInt(1700000700), nanos: 0 },
                } as any,
            };

            render(
                <DetailsPane
                    item={item as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('Last Viewed')).toBeDefined();
            expect(screen.getByText('Acknowledged')).toBeDefined();
        });
        it('condenses multiple commits to only show the most recent commit in timeline', () => {
            const itemWithCommits: Partial<Item> = {
                ...mockProtoItemWithBody,
                commits: [
                    {
                        authorLogin: 'committer1',
                        committedDate: { seconds: BigInt(1700000100), nanos: 0 },
                    } as any,
                    {
                        authorLogin: 'committer2',
                        committedDate: { seconds: BigInt(1700000900), nanos: 0 },
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithCommits as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('committer2')).toBeDefined();
            expect(screen.queryByText('committer1')).toBeNull();
        });

        it('renders consolidated CI failure indicator at bottom of timeline when bot comments fail', () => {
            const itemWithFailingCi: Partial<Item> = {
                ...mockProtoItemWithBody,
                comments: [
                    {
                        author: { login: 'k8s-ci-robot[bot]', avatarUrl: '', type: 2 },
                        bodyText: 'Build and unit test suite failed: 2 errors encountered.',
                        createdAt: { seconds: BigInt(1700000500), nanos: 0 },
                        commentId: BigInt(101),
                        noiseType: CommentNoiseType.BOT_AUTHOR,
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithFailingCi as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('CI / Checks Failing')).toBeDefined();
            expect(screen.getByText(/1 automated check or test failed/)).toBeDefined();
        });

        it('does not render CI failure indicator when there are no CI failures', () => {
            const itemWithPassingCi: Partial<Item> = {
                ...mockProtoItemWithBody,
                comments: [
                    {
                        author: { login: 'github-actions[bot]', avatarUrl: '', type: 2 },
                        bodyText: 'All test suites completed successfully with zero errors.',
                        createdAt: { seconds: BigInt(1700000500), nanos: 0 },
                        commentId: BigInt(102),
                        noiseType: CommentNoiseType.BOT_AUTHOR,
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithPassingCi as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.queryByText('CI / Checks Failing')).toBeNull();
        });

        it('renders clickable link for regular human comments to GitHub comment url', () => {
            const itemWithComment: Partial<Item> = {
                ...mockProtoItemWithBody,
                comments: [
                    {
                        author: { login: 'alice', avatarUrl: '', type: 1 },
                        bodyText: 'Please take a look at my review comments.',
                        createdAt: { seconds: BigInt(1700000100), nanos: 0 },
                        commentId: BigInt(9876),
                        noiseType: CommentNoiseType.UNSPECIFIED,
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithComment as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            const commentLink = screen.getByRole('link', { name: /\d+\/\d+\/\d+|ago|Never/ });
            expect(commentLink).toBeDefined();
            expect(commentLink.getAttribute('href')).toBe('https://github.com/owner/repo/pull/456#issuecomment-9876');
            expect(commentLink.getAttribute('target')).toBe('_blank');
        });

        it('groups maintainer slash commands like /hold into bot interactions', () => {
            const itemWithSlashCommand: Partial<Item> = {
                ...mockProtoItemWithBody,
                comments: [
                    {
                        author: { login: 'tallclair', avatarUrl: '', type: 1 },
                        bodyText: '/hold Depends on #140366',
                        createdAt: { seconds: BigInt(1700000100), nanos: 0 },
                        commentId: BigInt(5555),
                        noiseType: CommentNoiseType.SLASH_COMMAND,
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithSlashCommand as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText(/1 bot interactions hidden/)).toBeDefined();
        });

        it('renders PR reviews without body as timeline line with comments summary', () => {
            const itemWithReview: Partial<Item> = {
                ...mockProtoItemWithBody,
                reviews: [
                    {
                        author: { login: 'yongruilin', avatarUrl: 'https://avatar.url', type: 1 },
                        state: 'COMMENTED',
                        submittedAt: { seconds: BigInt(1700000200), nanos: 0 },
                        commentCount: 5,
                        url: 'https://github.com/owner/repo/pull/456#pullrequestreview-1',
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithReview as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('yongruilin')).toBeDefined();
            expect(screen.getByText('Reviewed')).toBeDefined();
            expect(screen.getByText(/5 comments/)).toBeDefined();
        });

        it('renders PR reviews with top-level comment body similar to regular comments', () => {
            const itemWithReviewBody: Partial<Item> = {
                ...mockProtoItemWithBody,
                reviews: [
                    {
                        author: { login: 'seniorReviewer', avatarUrl: 'https://avatar.url', type: 1 },
                        state: 'APPROVED',
                        submittedAt: { seconds: BigInt(1700000300), nanos: 0 },
                        body: '### Review Summary\nLooks great to merge after CI passes.',
                        commentCount: 2,
                        url: 'https://github.com/owner/repo/pull/456#pullrequestreview-2',
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithReviewBody as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('seniorReviewer')).toBeDefined();
            expect(screen.getByText('Approved')).toBeDefined();
            expect(screen.getByText(/2 comments/)).toBeDefined();
            expect(screen.getByText('Review Summary')).toBeDefined();
            expect(screen.getByText(/Looks great to merge after CI passes/)).toBeDefined();
        });

        it('renders PR review with mixed comments and replies summary in timeline line', () => {
            const itemWithMixedReview: Partial<Item> = {
                ...mockProtoItemWithBody,
                reviews: [
                    {
                        author: { login: 'yongruilin', avatarUrl: 'https://avatar.url', type: 1 },
                        state: 'COMMENTED',
                        submittedAt: { seconds: BigInt(1700000200), nanos: 0 },
                        commentCount: 5,
                        newThreadsCount: 4,
                        replyCount: 1,
                        url: 'https://github.com/owner/repo/pull/456#pullrequestreview-1',
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithMixedReview as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('yongruilin')).toBeDefined();
            expect(screen.getByText('Reviewed')).toBeDefined();
            expect(screen.getByText(/4 comments, 1 reply/)).toBeDefined();
        });

        it('previews up to 3 review comments in prominent review card', () => {
            const itemWithComments: Partial<Item> = {
                ...mockProtoItemWithBody,
                reviews: [
                    {
                        author: { login: 'codeReviewer', avatarUrl: 'https://avatar.url', type: 1 },
                        state: 'COMMENTED',
                        submittedAt: { seconds: BigInt(1700000200), nanos: 0 },
                        commentCount: 5,
                        newThreadsCount: 4,
                        replyCount: 1,
                        url: 'https://github.com/owner/repo/pull/456#pullrequestreview-99',
                        comments: [
                            { id: '1', body: 'First review comment snippet', path: 'pkg/api/v1.go' },
                            { id: '2', body: 'Second review comment snippet', path: 'pkg/api/v2.go' },
                            { id: '3', body: 'Third review comment snippet', path: 'pkg/api/v3.go' },
                            { id: '4', body: 'Fourth comment hidden behind link', path: 'pkg/api/v4.go' },
                        ],
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithComments as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('codeReviewer')).toBeDefined();
            expect(screen.getByText('pkg/api/v1.go')).toBeDefined();
            expect(screen.getByText('First review comment snippet')).toBeDefined();
            expect(screen.getByText('Second review comment snippet')).toBeDefined();
            expect(screen.getByText('Third review comment snippet')).toBeDefined();
            expect(screen.getByText('+ 2 more comments on GitHub →')).toBeDefined();
        });

        it('renders milestone badge in header when milestone is present', () => {
            const itemWithMilestone: Partial<Item> = {
                ...mockProtoItemWithBody,
                milestone: {
                    id: 'MS_123',
                    number: 2,
                    title: 'v1.33 Release',
                } as any,
            };

            render(
                <DetailsPane
                    item={itemWithMilestone as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('v1.33 Release')).toBeDefined();
        });

        it('renders label badges in header when labels are present', () => {
            const itemWithLabels: Partial<Item> = {
                ...mockProtoItemWithBody,
                labels: [
                    { name: 'area/networking', color: '0075ca' } as any,
                    { name: 'priority/urgent', color: 'd73a4a' } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithLabels as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('area/networking')).toBeDefined();
            expect(screen.getByText('priority/urgent')).toBeDefined();
        });

        it('renders merged, closed, and reopened state events in timeline', () => {
            const itemWithStateEvents: Partial<Item> = {
                ...mockProtoItemWithBody,
                stateEvents: [
                    {
                        type: 1, // CLOSED
                        createdAt: { seconds: BigInt(1700000100), nanos: 0 },
                        actor: { login: 'closerGuy', avatarUrl: '' } as any,
                        url: 'https://github.com/owner/repo/pull/456#event-1',
                    } as any,
                    {
                        type: 3, // REOPENED
                        createdAt: { seconds: BigInt(1700000200), nanos: 0 },
                        actor: { login: 'reopenGirl', avatarUrl: '' } as any,
                    } as any,
                    {
                        type: 2, // MERGED
                        createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                        actor: { login: 'mergerBot', avatarUrl: '' } as any,
                        url: 'https://github.com/owner/repo/pull/456#event-2',
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithStateEvents as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByTestId('state-change-closed')).toBeDefined();
            expect(screen.getByText(/closerGuy/)).toBeDefined();
            expect(screen.getByText(/closed/)).toBeDefined();

            expect(screen.getByTestId('state-change-reopened')).toBeDefined();
            expect(screen.getByText(/reopenGirl/)).toBeDefined();
            expect(screen.getByText(/reopened/)).toBeDefined();

            expect(screen.getByTestId('state-change-merged')).toBeDefined();
            expect(screen.getByText(/mergerBot/)).toBeDefined();
            expect(screen.getByText(/merged/)).toBeDefined();
        });

        it('suppresses redundant close event after merge event in DetailsPane', () => {
            const mergedItemWithClose: Partial<Item> = {
                ...mockProtoItemWithBody,
                state: ItemState.MERGED,
                stateEvents: [
                    {
                        type: 2, // MERGED
                        createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                        actor: { login: 'mergerBot', avatarUrl: '' } as any,
                        url: 'https://github.com/owner/repo/pull/456#event-merge',
                    } as any,
                    {
                        type: 1, // CLOSED (auto-emitted upon merge)
                        createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                        actor: { login: 'mergerBot', avatarUrl: '' } as any,
                        url: 'https://github.com/owner/repo/pull/456#event-close',
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={mergedItemWithClose as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByTestId('state-change-merged')).toBeDefined();
            expect(screen.getByText(/mergerBot/)).toBeDefined();
            expect(screen.getByText(/merged/)).toBeDefined();
            expect(screen.queryByTestId('state-change-closed')).toBeNull();
        });

        it('renders ASSIGNED state change event in timeline', () => {
            const itemWithAssigned: Partial<Item> = {
                ...mockProtoItemWithBody,
                stateEvents: [
                    {
                        type: 4, // ASSIGNED
                        createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                        actor: { login: 'sigLead', avatarUrl: '' } as any,
                        url: 'https://github.com/owner/repo/pull/456#event-assigned',
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithAssigned as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByTestId('state-change-assigned')).toBeDefined();
            expect(screen.getByText(/sigLead/)).toBeDefined();
            expect(screen.getByText(/assigned/)).toBeDefined();
        });

        it('renders sync error warning banner when syncError is present', () => {
            const itemWithSyncError: Partial<Item> = {
                ...mockProtoItemWithBody,
                local: {
                    ...mockProtoItemWithBody.local,
                    syncError: 'Failed to hydrate comments: 502 Bad Gateway',
                } as any,
            };

            render(
                <DetailsPane
                    item={itemWithSyncError as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            const banner = screen.getByTestId('sync-error-banner');
            expect(banner).toBeDefined();
            expect(banner.textContent).toContain('Failed to hydrate comments: 502 Bad Gateway');
        });

        it('renders Untracked badge in header when viewerSubscription is UNSUBSCRIBED', () => {
            const untrackedItem: Partial<Item> = {
                ...mockProtoItemWithBody,
                viewerSubscription: 2 as any, // SubscriptionState.UNSUBSCRIBED
            };

            render(
                <DetailsPane
                    item={untrackedItem as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            const badge = screen.getByTestId('details-untracked-badge');
            expect(badge).toBeDefined();
            expect(badge.textContent).toBe('Untracked');
            expect(badge.getAttribute('title')).toBe("Not subscribed on GitHub. Live updates won't be received automatically unless you subscribe or are mentioned.");
        });

        it('renders Untracked button in header when onSubscribe is provided and viewerSubscription is UNSUBSCRIBED', () => {
            const untrackedItem: Partial<Item> = {
                ...mockProtoItemWithBody,
                viewerSubscription: SubscriptionState.UNSUBSCRIBED,
            };

            render(
                <DetailsPane
                    item={untrackedItem as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onSubscribe={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            const badge = screen.getByTestId('details-untracked-badge');
            expect(badge.tagName).toBe('BUTTON');
            expect(badge.getAttribute('aria-label')).toBe('Subscribe to item (untracked)');
            expect(badge.getAttribute('title')).toBe("Not subscribed on GitHub. Live updates won't be received automatically unless you subscribe or are mentioned.");
        });

        it('calls onSubscribe with item id when clicking Untracked button in DetailsPane', async () => {
            const onSubscribe = vi.fn().mockResolvedValue(undefined);
            const untrackedItem: Partial<Item> = {
                ...mockProtoItemWithBody,
                id: 'PR_details_subscribe_test',
                viewerSubscription: SubscriptionState.UNSUBSCRIBED,
            };

            render(
                <DetailsPane
                    item={untrackedItem as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onSubscribe={onSubscribe}
                    onClose={vi.fn()}
                />
            );

            const badge = screen.getByTestId('details-untracked-badge');
            await act(async () => {
                fireEvent.click(badge);
            });

            expect(onSubscribe).toHaveBeenCalledTimes(1);
            expect(onSubscribe).toHaveBeenCalledWith('PR_details_subscribe_test');
        });

        it('shows loading state (spinner) and disables button while subscription mutation is pending in DetailsPane', async () => {
            let resolvePromise!: () => void;
            const pendingPromise = new Promise<void>((resolve) => {
                resolvePromise = resolve;
            });
            const onSubscribe = vi.fn().mockReturnValue(pendingPromise);

            const untrackedItem: Partial<Item> = {
                ...mockProtoItemWithBody,
                id: 'PR_details_spinner_test',
                viewerSubscription: SubscriptionState.UNSUBSCRIBED,
            };

            render(
                <DetailsPane
                    item={untrackedItem as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onSubscribe={onSubscribe}
                    onClose={vi.fn()}
                />
            );

            const badge = screen.getByTestId('details-untracked-badge');
            expect(badge.hasAttribute('disabled')).toBe(false);
            expect(screen.queryByTestId('details-untracked-spinner')).toBeNull();

            // Trigger click
            fireEvent.click(badge);

            // Assert pending loading state
            expect(badge.hasAttribute('disabled')).toBe(true);
            const spinner = screen.getByTestId('details-untracked-spinner');
            expect(spinner).toBeDefined();
            expect(spinner.classList.contains('animate-spin')).toBe(true);

            // Resolve mutation
            await act(async () => {
                resolvePromise();
            });

            // Assert restored idle state
            expect(badge.hasAttribute('disabled')).toBe(false);
            expect(screen.queryByTestId('details-untracked-spinner')).toBeNull();
        });

        it('disables Untracked button and shows missing notifications scope tooltip when canSubscribe is false', async () => {
            const onSubscribe = vi.fn();
            const untrackedItem: Partial<Item> = {
                ...mockProtoItemWithBody,
                id: 'PR_details_missing_scope',
                viewerSubscription: SubscriptionState.UNSUBSCRIBED,
            };

            render(
                <DetailsPane
                    item={untrackedItem as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onSubscribe={onSubscribe}
                    canSubscribe={false}
                    onClose={vi.fn()}
                />
            );

            const badge = screen.getByTestId('details-untracked-badge');
            expect(badge.hasAttribute('disabled')).toBe(true);
            expect(badge.className).toContain('cursor-not-allowed');
            expect(badge.getAttribute('title')).toContain('gh auth refresh -s notifications');
            expect(screen.getByRole('tooltip').textContent).toContain('gh auth refresh -s notifications');

            await act(async () => {
                fireEvent.click(badge);
            });
            expect(onSubscribe).not.toHaveBeenCalled();
        });

    });

    describe('Ack / Acked Button', () => {
        it('renders Ack button when item is not acked and calls onAck on click', () => {
            const onAck = vi.fn();
            render(
                <DetailsPane
                    item={mockProtoItemWithBody as Item}
                    onAck={onAck}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            const ackButton = screen.getByRole('button', { name: /^Ack$/i });
            expect(ackButton).toBeDefined();
            expect(screen.queryByRole('button', { name: /^Acked$/i })).toBeNull();

            fireEvent.click(ackButton);
            expect(onAck).toHaveBeenCalledWith('owner/repo#456');
        });

        it('renders Acked button with green styling when item is acked and calls onUnack on click', () => {
            const onUnack = vi.fn();
            const ackedItem: Partial<Item> = {
                ...mockProtoItemWithBody,
                local: {
                    ...mockProtoItemWithBody.local,
                    computedStatus: ItemStatus.ACKED,
                } as any,
            };

            render(
                <DetailsPane
                    item={ackedItem as Item}
                    onAck={vi.fn()}
                    onUnack={onUnack}
                    onClose={vi.fn()}
                />
            );

            const ackedButton = screen.getByRole('button', { name: /^Acked$/i });
            expect(ackedButton).toBeDefined();
            expect(ackedButton.className).toContain('text-green-600');
            expect(ackedButton.className).toContain('dark:text-green-400');
            expect(screen.queryByRole('button', { name: /^Ack$/i })).toBeNull();

            fireEvent.click(ackedButton);
            expect(onUnack).toHaveBeenCalledWith('owner/repo#456');
        });
    });

    describe('Date tooltips', () => {
        it('renders exact date-time tooltip on author updated timestamp and timeline entries', () => {
            const protoItem: Partial<Item> = {
                ...mockProtoItemWithBody,
                updatedAt: { seconds: BigInt(1700000000), nanos: 0 } as any,
                comments: [
                    {
                        commentId: BigInt(1),
                        bodyText: 'Hello world',
                        author: { login: 'commenter', avatarUrl: '' } as any,
                        createdAt: { seconds: BigInt(1700000100), nanos: 0 },
                        url: 'https://github.com/owner/repo/pull/456#issuecomment-1',
                    } as any,
                ],
                commits: [
                    {
                        authorLogin: 'committer',
                        committedDate: { seconds: BigInt(1700000200), nanos: 0 },
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={protoItem as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            const latestActivityExpected = new Date(1700000200000).toLocaleString();
            const commentExpected = new Date(1700000100000).toLocaleString();

            const tooltips = screen.getAllByTitle(latestActivityExpected);
            expect(tooltips.length).toBeGreaterThanOrEqual(1); // Author updated header + commit entry
            expect(screen.getByTitle(commentExpected)).toBeDefined();
        });

        it('renders DRAFT state badge and draft icon for open draft PR', () => {
            const draftPrItem: Partial<Item> = {
                ...mockProtoItemWithBody,
                isDraft: true,
                state: ItemState.OPEN,
            };

            render(
                <DetailsPane
                    item={draftPrItem as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('DRAFT')).toBeDefined();
            expect(screen.queryByText('OPEN')).toBeNull();
            expect(screen.getByLabelText('Draft Pull Request')).toBeDefined();
        });

        it('renders OPEN state badge and regular PR icon for open non-draft PR', () => {
            const readyPrItem: Partial<Item> = {
                ...mockProtoItemWithBody,
                isDraft: false,
                state: ItemState.OPEN,
            };

            render(
                <DetailsPane
                    item={readyPrItem as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('OPEN')).toBeDefined();
            expect(screen.queryByText('DRAFT')).toBeNull();
            expect(screen.queryByLabelText('Draft Pull Request')).toBeNull();
        });

        it('renders CLOSED state badge for closed draft PR', () => {
            const closedDraftPrItem: Partial<Item> = {
                ...mockProtoItemWithBody,
                isDraft: true,
                state: ItemState.CLOSED,
            };

            render(
                <DetailsPane
                    item={closedDraftPrItem as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('CLOSED')).toBeDefined();
            expect(screen.queryByText('DRAFT')).toBeNull();
            const closedIcon = screen.getByLabelText('Closed Pull Request');
            expect(closedIcon).toBeDefined();
            expect(closedIcon.classList.contains('text-red-600')).toBe(true);
        });

        it('renders MERGED state badge and purple merge icon for merged PR', () => {
            const mergedPrItem: Partial<Item> = {
                ...mockProtoItemWithBody,
                isDraft: false,
                state: ItemState.MERGED,
            };

            render(
                <DetailsPane
                    item={mergedPrItem as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByText('MERGED')).toBeDefined();
            const mergeIcon = screen.getByLabelText('Merged Pull Request');
            expect(mergeIcon).toBeDefined();
            expect(mergeIcon.classList.contains('text-purple-600')).toBe(true);
        });
    });

    describe('Review Comment Thread Expansion and Timestamp Links', () => {
        it('renders view thread as an interactive button instead of an external link and toggles thread expansion and collapse', () => {
            const itemWithThread: Partial<Item> = {
                ...mockProtoItemWithBody,
                reviews: [
                    {
                        author: { login: 'aliceReviewer', avatarUrl: 'https://avatar.url/alice', type: 1 },
                        state: 'COMMENTED',
                        submittedAt: { seconds: BigInt(1700000100), nanos: 0 },
                        commentCount: 4,
                        url: 'https://github.com/owner/repo/pull/456#pullrequestreview-10',
                        comments: [
                            { id: 'other1', body: 'Unrelated comment 1', path: 'pkg/a.go' },
                            { id: 'other2', body: 'Unrelated comment 2', path: 'pkg/b.go' },
                            { id: 'other3', body: 'Unrelated comment 3', path: 'pkg/c.go' },
                            {
                                id: 'c_root',
                                body: 'Root thread question about mutex locking',
                                path: 'pkg/sync.go',
                                url: 'https://github.com/owner/repo/pull/456#discussion_r1001',
                                author: { login: 'aliceReviewer', avatarUrl: 'https://avatar.url/alice' },
                                createdAt: { seconds: BigInt(1700000100), nanos: 0 },
                            },
                        ],
                    } as any,
                    {
                        author: { login: 'bobAuthor', avatarUrl: 'https://avatar.url/bob', type: 1 },
                        state: 'COMMENTED',
                        submittedAt: { seconds: BigInt(1700000200), nanos: 0 },
                        commentCount: 4,
                        url: 'https://github.com/owner/repo/pull/456#pullrequestreview-11',
                        comments: [
                            { id: 'other4', body: 'Unrelated comment 4', path: 'pkg/d.go' },
                            { id: 'other5', body: 'Unrelated comment 5', path: 'pkg/e.go' },
                            { id: 'other6', body: 'Unrelated comment 6', path: 'pkg/f.go' },
                            {
                                id: 'c_reply1',
                                body: 'First reply explaining lock acquisition order',
                                path: 'pkg/sync.go',
                                url: 'https://github.com/owner/repo/pull/456#discussion_r1002',
                                author: { login: 'bobAuthor', avatarUrl: 'https://avatar.url/bob' },
                                createdAt: { seconds: BigInt(1700000200), nanos: 0 },
                                replyToId: 'c_root',
                            },
                        ],
                    } as any,
                    {
                        author: { login: 'aliceReviewer', avatarUrl: 'https://avatar.url/alice', type: 1 },
                        state: 'COMMENTED',
                        submittedAt: { seconds: BigInt(1700000300), nanos: 0 },
                        commentCount: 1,
                        replyCount: 1,
                        url: 'https://github.com/owner/repo/pull/456#pullrequestreview-12',
                        comments: [
                            {
                                id: 'c_reply2',
                                body: 'Second reply confirming the fix works',
                                path: 'pkg/sync.go',
                                url: 'https://github.com/owner/repo/pull/456#discussion_r1003',
                                author: { login: 'aliceReviewer', avatarUrl: 'https://avatar.url/alice' },
                                createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                                replyToId: 'c_root',
                            },
                        ],
                    } as any,
                    {
                        author: { login: 'charlieLater', avatarUrl: 'https://avatar.url/charlie', type: 1 },
                        state: 'COMMENTED',
                        submittedAt: { seconds: BigInt(1700000400), nanos: 0 },
                        commentCount: 4,
                        url: 'https://github.com/owner/repo/pull/456#pullrequestreview-13',
                        comments: [
                            { id: 'other7', body: 'Unrelated comment 7', path: 'pkg/g.go' },
                            { id: 'other8', body: 'Unrelated comment 8', path: 'pkg/h.go' },
                            { id: 'other9', body: 'Unrelated comment 9', path: 'pkg/i.go' },
                            {
                                id: 'c_reply3_later',
                                body: 'Later reply that occurred after c_reply2',
                                path: 'pkg/sync.go',
                                url: 'https://github.com/owner/repo/pull/456#discussion_r1004',
                                author: { login: 'charlieLater', avatarUrl: 'https://avatar.url/charlie' },
                                createdAt: { seconds: BigInt(1700000400), nanos: 0 },
                                replyToId: 'c_root',
                            },
                        ],
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithThread as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            // Initially collapsed: ancestor bodies are not displayed in the expanded thread container
            expect(screen.queryByTestId('expanded-review-thread')).toBeNull();
            expect(screen.queryByText('Root thread question about mutex locking')).toBeNull();
            expect(screen.queryByText('First reply explaining lock acquisition order')).toBeNull();
            expect(screen.getByText('Second reply confirming the fix works')).toBeDefined();

            // Verify 'view thread' is a button, not an external link
            const viewThreadBtn = screen.getByRole('button', { name: /view thread/i });
            expect(viewThreadBtn.tagName).toBe('BUTTON');
            expect(viewThreadBtn.getAttribute('aria-expanded')).toBe('false');
            // Parentheses are part of the button label rather than loose surrounding text
            expect(viewThreadBtn.textContent).toBe('(view thread)');
            expect(viewThreadBtn.parentElement?.textContent).toBe('Reply to comment(view thread)');
            // The controlled region is not rendered while collapsed, so nothing is referenced yet
            expect(viewThreadBtn.hasAttribute('aria-controls')).toBe(false);

            // Click 'view thread' to expand in-place
            fireEvent.click(viewThreadBtn);

            const expandedContainer = screen.getByTestId('expanded-review-thread');
            expect(expandedContainer).toBeDefined();
            const controlledId = screen.getByRole('button', { name: /hide thread/i }).getAttribute('aria-controls');
            expect(controlledId).toBeTruthy();
            expect(expandedContainer.id).toBe(controlledId);

            // Verify ancestor comments and current reply are rendered in chronological order up to c_reply2
            const threadItems = screen.getAllByTestId('review-thread-comment');
            expect(threadItems).toHaveLength(3);
            expect(threadItems[0].textContent).toContain('aliceReviewer');
            expect(threadItems[0].textContent).toContain('Root thread question about mutex locking');
            expect(threadItems[1].textContent).toContain('bobAuthor');
            expect(threadItems[1].textContent).toContain('First reply explaining lock acquisition order');
            expect(threadItems[2].textContent).toContain('aliceReviewer');
            expect(threadItems[2].textContent).toContain('Second reply confirming the fix works');

            // Verify c_reply3_later (which came after c_reply2) is NOT shown in c_reply2's thread expansion
            expect(screen.queryByText('Later reply that occurred after c_reply2')).toBeNull();

            // Verify timestamps inside expanded thread link directly to each comment's GitHub URL
            const link0 = threadItems[0].querySelector('a');
            expect(link0?.getAttribute('href')).toBe('https://github.com/owner/repo/pull/456#discussion_r1001');
            expect(link0?.getAttribute('target')).toBe('_blank');
            expect(link0?.getAttribute('rel')).toBe('noopener noreferrer');

            const link1 = threadItems[1].querySelector('a');
            expect(link1?.getAttribute('href')).toBe('https://github.com/owner/repo/pull/456#discussion_r1002');
            expect(link1?.getAttribute('target')).toBe('_blank');

            const link2 = threadItems[2].querySelector('a');
            expect(link2?.getAttribute('href')).toBe('https://github.com/owner/repo/pull/456#discussion_r1003');
            expect(link2?.getAttribute('target')).toBe('_blank');

            // Click 'hide thread' to collapse back to compact view
            const hideThreadBtn = screen.getByRole('button', { name: /hide thread/i });
            expect(hideThreadBtn.getAttribute('aria-expanded')).toBe('true');
            fireEvent.click(hideThreadBtn);

            expect(screen.queryByTestId('expanded-review-thread')).toBeNull();
            expect(screen.queryByText('Root thread question about mutex locking')).toBeNull();
            expect(screen.getByText('Second reply confirming the fix works')).toBeDefined();
            // When root is present, "view full thread on GitHub" link is NOT rendered
            expect(screen.queryByRole('link', { name: /view full thread on GitHub/i })).toBeNull();
        });

        it('renders "view full thread on GitHub" link pointing to the PR files view when rootMissing is true', () => {
            const itemWithMissingRoot: Partial<Item> = {
                ...mockProtoItemWithBody,
                reviews: [
                    {
                        author: { login: 'bobAuthor', avatarUrl: 'https://avatar.url/bob', type: 1 },
                        state: 'COMMENTED',
                        submittedAt: { seconds: BigInt(1700000300), nanos: 0 },
                        commentCount: 2,
                        replyCount: 2,
                        url: 'https://github.com/owner/repo/pull/456#pullrequestreview-20',
                        comments: [
                            {
                                id: 'c_prior_reply',
                                body: 'Prior reply in thread whose root review is missing',
                                path: 'pkg/sync.go',
                                url: 'https://github.com/owner/repo/pull/456#discussion_r3001',
                                author: { login: 'aliceReviewer', avatarUrl: 'https://avatar.url/alice' },
                                createdAt: { seconds: BigInt(1700000200), nanos: 0 },
                                replyToId: 'c_missing_root',
                            },
                            {
                                id: 'c_reply_target',
                                body: 'Target reply with missing root',
                                path: 'pkg/sync.go',
                                url: 'https://github.com/owner/repo/pull/456#discussion_r3002',
                                author: { login: 'bobAuthor', avatarUrl: 'https://avatar.url/bob' },
                                createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                                replyToId: 'c_missing_root',
                            },
                        ],
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithMissingRoot as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            const viewThreadBtns = screen.getAllByRole('button', { name: /view thread/i });
            fireEvent.click(viewThreadBtns[1]);

            const fullThreadLink = screen.getByRole('link', { name: /view full thread on GitHub/i });
            expect(fullThreadLink).toBeDefined();
            expect(fullThreadLink.getAttribute('href')).toBe('https://github.com/owner/repo/pull/456/files');
            expect(fullThreadLink.getAttribute('target')).toBe('_blank');
            expect(fullThreadLink.getAttribute('rel')).toBe('noopener noreferrer');

            const threadItems = screen.getAllByTestId('review-thread-comment');
            expect(threadItems).toHaveLength(2);
            expect(threadItems[0].textContent).toContain('Prior reply in thread whose root review is missing');
            expect(threadItems[1].textContent).toContain('Target reply with missing root');
        });

        it('does not render the "view full thread on GitHub" link when no PR URL is available', () => {
            const itemWithoutUrl: Partial<Item> = {
                ...mockProtoItemWithBody,
                url: '',
                reviews: [
                    {
                        author: { login: 'bobAuthor', avatarUrl: 'https://avatar.url/bob', type: 1 },
                        state: 'COMMENTED',
                        submittedAt: { seconds: BigInt(1700000300), nanos: 0 },
                        commentCount: 1,
                        replyCount: 1,
                        comments: [
                            {
                                id: 'c_orphan_reply',
                                body: 'Reply whose root is not loaded',
                                replyToId: 'c_missing_root',
                                createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                            },
                        ],
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithoutUrl as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            fireEvent.click(screen.getByRole('button', { name: /view thread/i }));
            expect(screen.getByTestId('expanded-review-thread')).toBeDefined();
            expect(screen.queryByRole('link', { name: /view full thread on GitHub/i })).toBeNull();
        });

        it('keeps an expanded thread expanded when a new timeline entry is inserted before the review', () => {
            const reviewWithReply = {
                author: { login: 'bobAuthor', avatarUrl: 'https://avatar.url/bob', type: 1 },
                state: 'COMMENTED',
                submittedAt: { seconds: BigInt(1700000300), nanos: 0 },
                commentCount: 2,
                url: 'https://github.com/owner/repo/pull/456#pullrequestreview-30',
                comments: [
                    {
                        id: 'c_root',
                        body: 'Root comment body',
                        url: 'https://github.com/owner/repo/pull/456#discussion_r4001',
                        createdAt: { seconds: BigInt(1700000200), nanos: 0 },
                    },
                    {
                        id: 'c_reply',
                        body: 'Reply comment body',
                        url: 'https://github.com/owner/repo/pull/456#discussion_r4002',
                        replyToId: 'c_root',
                        createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                    },
                ],
            } as any;
            const initialItem: Partial<Item> = { ...mockProtoItemWithBody, reviews: [reviewWithReply] };

            const { rerender } = render(
                <DetailsPane item={initialItem as Item} onAck={vi.fn()} onUnack={vi.fn()} onClose={vi.fn()} />
            );

            fireEvent.click(screen.getByRole('button', { name: /view thread/i }));
            expect(screen.getByTestId('expanded-review-thread')).toBeDefined();

            // A new comment older than the review shifts the review's position in the timeline.
            const updatedItem: Partial<Item> = {
                ...initialItem,
                comments: [
                    {
                        bodyText: 'Earlier issue comment inserted before the review',
                        author: { login: 'carol', avatarUrl: 'https://avatar.url/carol' },
                        createdAt: { seconds: BigInt(1700000000), nanos: 0 },
                    } as any,
                ],
            };
            rerender(
                <DetailsPane item={updatedItem as Item} onAck={vi.fn()} onUnack={vi.fn()} onClose={vi.fn()} />
            );

            expect(screen.getByText('Earlier issue comment inserted before the review')).toBeDefined();
            expect(screen.getByTestId('expanded-review-thread')).toBeDefined();
            expect(screen.getByRole('button', { name: /hide thread/i }).getAttribute('aria-expanded')).toBe('true');
        });

        it('collapses expanded threads when switching to a different item with the same comment ids', () => {
            const reviewWithReply = {
                author: { login: 'bobAuthor', avatarUrl: 'https://avatar.url/bob', type: 1 },
                state: 'COMMENTED',
                submittedAt: { seconds: BigInt(1700000300), nanos: 0 },
                commentCount: 2,
                url: 'https://github.com/owner/repo/pull/456#pullrequestreview-31',
                comments: [
                    {
                        id: 'c_root',
                        body: 'Root comment body',
                        url: 'https://github.com/owner/repo/pull/456#discussion_r5001',
                        createdAt: { seconds: BigInt(1700000200), nanos: 0 },
                    },
                    {
                        id: 'c_reply',
                        body: 'Reply comment body',
                        url: 'https://github.com/owner/repo/pull/456#discussion_r5002',
                        replyToId: 'c_root',
                        createdAt: { seconds: BigInt(1700000300), nanos: 0 },
                    },
                ],
            } as any;
            const firstItem: Partial<Item> = { ...mockProtoItemWithBody, reviews: [reviewWithReply] };

            const { rerender } = render(
                <DetailsPane item={firstItem as Item} onAck={vi.fn()} onUnack={vi.fn()} onClose={vi.fn()} />
            );

            fireEvent.click(screen.getByRole('button', { name: /view thread/i }));
            expect(screen.getByTestId('expanded-review-thread')).toBeDefined();

            // A different item whose reply shares the same comment id must not inherit the expansion.
            const secondItem: Partial<Item> = { ...firstItem, id: `${mockProtoItemWithBody.id}_other` };
            rerender(
                <DetailsPane item={secondItem as Item} onAck={vi.fn()} onUnack={vi.fn()} onClose={vi.fn()} />
            );

            expect(screen.queryByTestId('expanded-review-thread')).toBeNull();
            const viewThreadBtn = screen.getByRole('button', { name: /view thread/i });
            expect(viewThreadBtn.textContent).toBe('(view thread)');
            expect(viewThreadBtn.getAttribute('aria-expanded')).toBe('false');
        });

        it('renders review comment timestamps as external links to GitHub in standalone/compact view', () => {
            const itemWithStandaloneReviewComment: Partial<Item> = {
                ...mockProtoItemWithBody,
                reviews: [
                    {
                        author: { login: 'reviewerOne', avatarUrl: 'https://avatar.url/one', type: 1 },
                        state: 'COMMENTED',
                        submittedAt: { seconds: BigInt(1700000500), nanos: 0 },
                        commentCount: 1,
                        url: 'https://github.com/owner/repo/pull/456#pullrequestreview-55',
                        comments: [
                            {
                                id: 'rc_standalone',
                                body: 'Standalone review comment body',
                                path: 'pkg/server/handler.go',
                                url: 'https://github.com/owner/repo/pull/456#discussion_r2001',
                                createdAt: { seconds: BigInt(1700000550), nanos: 0 },
                            },
                        ],
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithStandaloneReviewComment as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            const expectedTooltip = new Date(1700000550 * 1000).toLocaleString();
            const timestampLink = screen.getByTitle(expectedTooltip);
            expect(timestampLink.tagName).toBe('A');
            expect(timestampLink.getAttribute('href')).toBe('https://github.com/owner/repo/pull/456#discussion_r2001');
            expect(timestampLink.getAttribute('target')).toBe('_blank');
            expect(timestampLink.getAttribute('rel')).toBe('noopener noreferrer');
        });

        it('does not synthesize fallback timestamps for review comments or thread ancestors when createdAt is unset', () => {
            const itemWithMissingCreatedAt: Partial<Item> = {
                ...mockProtoItemWithBody,
                reviews: [
                    {
                        author: { login: 'aliceReviewer', avatarUrl: 'https://avatar.url/alice', type: 1 },
                        state: 'COMMENTED',
                        submittedAt: { seconds: BigInt(1700000100), nanos: 0 },
                        commentCount: 1,
                        url: 'https://github.com/owner/repo/pull/456#pullrequestreview-70',
                        comments: [
                            {
                                id: 'c_root_unset_ts',
                                body: 'Root comment with missing createdAt',
                                path: 'pkg/sync.go',
                                url: 'https://github.com/owner/repo/pull/456#discussion_r7001',
                                author: { login: 'aliceReviewer', avatarUrl: 'https://avatar.url/alice' },
                            },
                        ],
                    } as any,
                    {
                        author: { login: 'bobAuthor', avatarUrl: 'https://avatar.url/bob', type: 1 },
                        state: 'COMMENTED',
                        submittedAt: { seconds: BigInt(1700000200), nanos: 0 },
                        commentCount: 1,
                        replyCount: 1,
                        url: 'https://github.com/owner/repo/pull/456#pullrequestreview-71',
                        comments: [
                            {
                                id: 'c_reply_with_ts',
                                body: 'Reply comment with valid createdAt',
                                path: 'pkg/sync.go',
                                url: 'https://github.com/owner/repo/pull/456#discussion_r7002',
                                author: { login: 'bobAuthor', avatarUrl: 'https://avatar.url/bob' },
                                createdAt: { seconds: BigInt(1700000250), nanos: 0 },
                                replyToId: 'c_root_unset_ts',
                            },
                        ],
                    } as any,
                ],
            };

            render(
                <DetailsPane
                    item={itemWithMissingCreatedAt as Item}
                    onAck={vi.fn()}
                    onUnack={vi.fn()}
                    onClose={vi.fn()}
                />
            );

            const viewThreadBtn = screen.getByRole('button', { name: /view thread/i });
            fireEvent.click(viewThreadBtn);

            const threadItems = screen.getAllByTestId('review-thread-comment');
            expect(threadItems).toHaveLength(2);
            // Ancestor with unset createdAt must NOT render a timestamp link or fallback timestamp
            expect(threadItems[0].querySelector('a')).toBeNull();
            // Reply with valid createdAt renders its own timestamp link
            const replyLink = threadItems[1].querySelector('a');
            expect(replyLink).not.toBeNull();
            expect(replyLink?.getAttribute('href')).toBe('https://github.com/owner/repo/pull/456#discussion_r7002');
        });
    });
});


