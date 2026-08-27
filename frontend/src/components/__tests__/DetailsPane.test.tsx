/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, fireEvent } from '@testing-library/react';
import { DetailsPane } from '../DetailsPane';
import { describe, it, expect, vi } from 'vitest';
import type { Item, User } from '../../api/octodeck/v1/resources_pb';
import { ItemType, ItemState, ItemStatus, CommentNoiseType } from '../../api/octodeck/v1/resources_pb';

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
});


