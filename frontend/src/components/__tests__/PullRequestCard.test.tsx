/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, fireEvent } from '@testing-library/react';
import { PullRequestCard } from '../PullRequestCard';
import { describe, it, expect, vi } from 'vitest';
import type { Item, User } from '../../api/octodeck/v1/resources_pb';
import { ItemType, ItemState, ItemStatus } from '../../api/octodeck/v1/resources_pb';

const mockItem: Item = {
  id: 'PR_kwDOK11',
  repo: 'owner/repo',
  number: 123,
  type: ItemType.PR,
  title: 'Test PR',
  state: ItemState.OPEN,
  url: 'https://github.com/owner/repo/pull/123',
  author: { login: 'user', avatarUrl: 'url' } as User,
  commits: [],
  comments: [],
  reviews: [],
  assignees: [],
  local: {
    computedStatus: ItemStatus.NEW,
    isAcked: false,
    privateNotes: '',
  } as unknown as NonNullable<Item['local']>,
} as unknown as Item;

const mockProtoItem: Partial<Item> = {
  id: 'owner/repo#456',
  repo: 'owner/repo',
  number: 456,
  type: ItemType.PR,
  title: 'Proto PR Test',
  state: ItemState.OPEN,
  url: 'https://github.com/owner/repo/pull/456',
  author: { login: 'protoUser', avatarUrl: 'https://avatar.url', type: 1 } as unknown as User,
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

describe('PullRequestCard', () => {
  it('renders correctly with Item', () => {
    const { asFragment } = render(<PullRequestCard item={mockItem as unknown as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(asFragment()).toMatchSnapshot();
  });

  it('renders NEW status correctly', () => {
    const item: Partial<Item> = {
      ...mockItem,
      local: { computedStatus: ItemStatus.NEW, isAcked: false, privateNotes: '' } as any,
    };
    render(<PullRequestCard item={item as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('New')).toBeDefined();
  });

  it('renders NEW_CODE status correctly', () => {
    const item: Partial<Item> = {
      ...mockItem,
      local: { computedStatus: ItemStatus.NEW_CODE, isAcked: false, privateNotes: '' } as any,
    };
    render(<PullRequestCard item={item as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('New Commit')).toBeDefined();
  });

  it('does not render status indicator text for NOISE status', () => {
    const item: Partial<Item> = {
      ...mockItem,
      local: { computedStatus: ItemStatus.NOISE, isAcked: false, privateNotes: '' } as any,
    };
    render(<PullRequestCard item={item as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.queryByText('Noise')).toBeNull();
  });

  it('renders Acked text for ACKED status', () => {
    const item: Partial<Item> = {
      ...mockItem,
      local: { computedStatus: ItemStatus.ACKED, isAcked: true, privateNotes: '' } as any,
    };
    render(<PullRequestCard item={item as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('Acked')).toBeDefined();
  });

  it('applies gray backing to acked items when grayAckedBackground is true', () => {
    const item: Partial<Item> = {
      ...mockItem,
      local: { computedStatus: ItemStatus.ACKED, isAcked: true, privateNotes: '' } as any,
    };
    const { container } = render(<PullRequestCard item={item as Item} isSelected={false} onSelect={vi.fn()} grayAckedBackground={true} />);
    const cardDiv = container.firstChild as HTMLElement;
    expect(cardDiv.className).toContain('bg-slate-100/70');
    expect(cardDiv.className).not.toContain('opacity-50');
  });

  it('uses regular background for acked items when grayAckedBackground is false', () => {
    const item: Partial<Item> = {
      ...mockItem,
      local: { computedStatus: ItemStatus.ACKED, isAcked: true, privateNotes: '' } as any,
    };
    const { container } = render(<PullRequestCard item={item as Item} isSelected={false} onSelect={vi.fn()} grayAckedBackground={false} />);
    const cardDiv = container.firstChild as HTMLElement;
    expect(cardDiv.className).not.toContain('bg-slate-100/70');
    expect(cardDiv.className).toContain('hover:bg-slate-50');
    expect(cardDiv.className).not.toContain('opacity-50');
  });

  it('renders IDLE status correctly (without Idle indicator)', () => {
    const item: Partial<Item> = {
      ...mockItem,
      local: { computedStatus: ItemStatus.IDLE, isAcked: false, privateNotes: '' } as any,
    };
    render(<PullRequestCard item={item as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('owner/repo #123')).toBeDefined();
    expect(screen.queryByText('Idle')).toBeNull();
  });

  it('renders ConnectRPC Protobuf Item correctly', () => {
    render(<PullRequestCard item={mockProtoItem as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('Proto PR Test')).toBeDefined();
    expect(screen.getByText('protoUser')).toBeDefined();
    expect(screen.getByText('owner/repo #456')).toBeDefined();
    expect(screen.getByText('New Activity')).toBeDefined();
  });

  it('renders author in metadata row before repository', () => {
    render(<PullRequestCard item={mockItem as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('user')).toBeDefined();
    expect(screen.getByText('owner/repo #123')).toBeDefined();
  });

  it('renders star icon at the beginning of metadata row when item is starred', () => {
    const starredItem: Partial<Item> = {
      ...mockItem,
      local: { computedStatus: ItemStatus.NEW, isAcked: false, starred: true } as any,
    };
    render(<PullRequestCard item={starredItem as Item} isSelected={false} onSelect={vi.fn()} />);
    const starEl = screen.getByLabelText('Starred item');
    expect(starEl).toBeDefined();
    const authorEl = screen.getByText('user');
    expect(starEl.compareDocumentPosition(authorEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not render star icon when item is unstarred', () => {
    const unstarredItem: Partial<Item> = {
      ...mockItem,
      local: { computedStatus: ItemStatus.NEW, isAcked: false, starred: false } as any,
    };
    render(<PullRequestCard item={unstarredItem as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.queryByLabelText('Starred item')).toBeNull();
  });

  it('renders latest comment activity with author inline and brighter text', () => {
    const itemWithComment: Partial<Item> = {
      ...mockItem,
      comments: [
        {
          bodyText: 'This is a review comment',
          author: { login: 'reviewer1', avatarUrl: 'url' },
          createdAt: { seconds: BigInt(1735819200), nanos: 0 },
          commentId: BigInt(1),
        } as any,
      ],
    };

    render(<PullRequestCard item={itemWithComment as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('reviewer1:')).toBeDefined();
    expect(screen.getByText('This is a review comment')).toBeDefined();
  });

  it('renders latest commit activity with author inline', () => {
    const itemWithCommit: Partial<Item> = {
      ...mockProtoItem,
      commits: [
        {
          authorLogin: 'contributor1',
          committedDate: { seconds: BigInt(1735732800), nanos: 0 },
        } as unknown as NonNullable<Item['commits']>[number],
      ],
    };

    render(<PullRequestCard item={itemWithCommit as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('contributor1:')).toBeDefined();
    expect(screen.getByText('Pushed new code')).toBeDefined();
  });

  it('skips leading block quote in comment preview when non-quote text is present', () => {
    const itemWithQuoteReply: Partial<Item> = {
      ...mockItem,
      comments: [
        {
          bodyText: '> @author wrote:\n> Can you address this?\n\nAddressed in latest commit!',
          author: { login: 'developer', avatarUrl: 'url' },
          createdAt: { seconds: BigInt(1735819200), nanos: 0 },
          commentId: BigInt(2),
        } as any,
      ],
    };

    render(<PullRequestCard item={itemWithQuoteReply as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('developer:')).toBeDefined();
    expect(screen.getByText('Addressed in latest commit!')).toBeDefined();
    expect(screen.queryByText(/@author wrote/)).toBeNull();
  });

  it('displays block quote if comment only contains quote text', () => {
    const itemWithOnlyQuote: Partial<Item> = {
      ...mockItem,
      comments: [
        {
          bodyText: '> Only quoted text here',
          author: { login: 'quoter', avatarUrl: 'url' },
          createdAt: { seconds: BigInt(1735819200), nanos: 0 },
          commentId: BigInt(3),
        } as any,
      ],
    };

    render(<PullRequestCard item={itemWithOnlyQuote as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('quoter:')).toBeDefined();
    expect(screen.getByText('> Only quoted text here')).toBeDefined();
  });

  it('does not render item ID when showItemId is false or omitted', () => {
    render(<PullRequestCard item={mockItem as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.queryByText(/ID: PR_kwDOK11/)).toBeNull();
  });

  it('renders item ID in metadata row when showItemId is true', () => {
    render(<PullRequestCard item={mockItem as Item} isSelected={false} onSelect={vi.fn()} showItemId={true} />);
    expect(screen.getByText('ID: PR_kwDOK11')).toBeDefined();
  });

  it('renders item ID for Protobuf Item when showItemId is true', () => {
    render(<PullRequestCard item={mockProtoItem as Item} isSelected={false} onSelect={vi.fn()} showItemId={true} />);
    expect(screen.getByText('ID: owner/repo#456')).toBeDefined();
  });

  it('calls onOpenDebug with item id when clicking item ID', () => {
    const onOpenDebug = vi.fn();
    const onSelect = vi.fn();
    render(
      <PullRequestCard
        item={mockItem}
        isSelected={false}
        onSelect={onSelect}
        showItemId={true}
        onOpenDebug={onOpenDebug}
      />
    );

    const idElement = screen.getByText('ID: PR_kwDOK11');
    fireEvent.click(idElement);

    expect(onOpenDebug).toHaveBeenCalledWith('PR_kwDOK11');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders latest review activity in preview row with comments count', () => {
    const itemWithReview: Partial<Item> = {
      ...mockProtoItem,
      reviews: [
        {
          author: { login: 'yongruilin', avatarUrl: 'https://avatar.url', type: 1 },
          state: 'COMMENTED',
          submittedAt: { seconds: BigInt(1700000200), nanos: 0 },
          commentCount: 5,
        } as any,
      ],
    };

    render(<PullRequestCard item={itemWithReview as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('yongruilin:')).toBeDefined();
    expect(screen.getByText('Reviewed (5 comments)')).toBeDefined();
  });

  it('renders latest review activity with top-level comment body and status', () => {
    const itemWithReview: Partial<Item> = {
      ...mockProtoItem,
      reviews: [
        {
          author: { login: 'reviewer1', avatarUrl: 'https://avatar.url', type: 1 },
          state: 'APPROVED',
          submittedAt: { seconds: BigInt(1700000200), nanos: 0 },
          body: 'LGTM! Looks great.',
          commentCount: 2,
        } as any,
      ],
    };

    render(<PullRequestCard item={itemWithReview as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('reviewer1:')).toBeDefined();
    expect(screen.getByText('Approved changes (2 comments): LGTM! Looks great.')).toBeDefined();
  });

  it('renders review activity with mixed new comments and replies', () => {
    const itemWithMixedReview: Partial<Item> = {
      ...mockProtoItem,
      reviews: [
        {
          author: { login: 'yongruilin', avatarUrl: 'https://avatar.url', type: 1 },
          state: 'COMMENTED',
          submittedAt: { seconds: BigInt(1700000200), nanos: 0 },
          commentCount: 5,
          newThreadsCount: 4,
          replyCount: 1,
        } as any,
      ],
    };

    render(<PullRequestCard item={itemWithMixedReview as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('yongruilin:')).toBeDefined();
    expect(screen.getByText('Reviewed (4 comments, 1 reply)')).toBeDefined();
  });

  it('renders milestone in metadata row when present', () => {
    const itemWithMilestone: Partial<Item> = {
      ...mockProtoItem,
      milestone: {
        id: 'MS_123',
        number: 1,
        title: 'v1.32 Release',
      } as any,
    };

    render(<PullRequestCard item={itemWithMilestone as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('v1.32 Release')).toBeDefined();
  });

  it('renders label badges when present', () => {
    const itemWithLabels: Partial<Item> = {
      ...mockProtoItem,
      labels: [
        { name: 'kind/bug', color: 'd73a4a' } as any,
        { name: 'size/L', color: '0075ca' } as any,
      ],
    };

    render(<PullRequestCard item={itemWithLabels as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('kind/bug')).toBeDefined();
    expect(screen.getByText('size/L')).toBeDefined();
  });

  it('triggers onSelect and prevents navigation when left-clicking item title', () => {
    const onSelect = vi.fn();
    render(<PullRequestCard item={mockItem} isSelected={false} onSelect={onSelect} />);

    const titleLink = screen.getByRole('link', { name: 'Test PR' });
    expect(titleLink.getAttribute('href')).toBe('https://github.com/owner/repo/pull/123');
    expect(titleLink.getAttribute('target')).toBe('_blank');

    const clickEvent = fireEvent.click(titleLink);
    expect(clickEvent).toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('does not trigger onSelect on card when ctrl-clicking item title', () => {
    const onSelect = vi.fn();
    render(<PullRequestCard item={mockItem} isSelected={false} onSelect={onSelect} />);

    const titleLink = screen.getByRole('link', { name: 'Test PR' });
    const clickEvent = fireEvent.click(titleLink, { ctrlKey: true });
    expect(clickEvent).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not trigger onSelect on card when meta-clicking item title', () => {
    const onSelect = vi.fn();
    render(<PullRequestCard item={mockItem} isSelected={false} onSelect={onSelect} />);

    const titleLink = screen.getByRole('link', { name: 'Test PR' });
    const clickEvent = fireEvent.click(titleLink, { metaKey: true });
    expect(clickEvent).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('stops propagation on auxclick (middle-click) on item title without selecting card', () => {
    const onSelect = vi.fn();
    render(<PullRequestCard item={mockItem} isSelected={false} onSelect={onSelect} />);

    const titleLink = screen.getByRole('link', { name: 'Test PR' });
    fireEvent(titleLink, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders sync error warning badge when syncError is present on item', () => {
    const itemWithSyncError: Partial<Item> = {
      ...mockItem,
      local: {
        computedStatus: ItemStatus.NEW,
        isAcked: false,
        privateNotes: '',
        syncError: 'GraphQL rate limit exceeded during node hydration',
      } as any,
    };

    render(<PullRequestCard item={itemWithSyncError as Item} isSelected={false} onSelect={vi.fn()} />);
    const warningBadge = screen.getByTestId('sync-error-badge');
    expect(warningBadge).toBeDefined();
    expect(warningBadge.getAttribute('title')).toContain('GraphQL rate limit exceeded');
  });

  it('renders Untracked badge when viewerSubscription is UNSUBSCRIBED', () => {
    const untrackedItem: Partial<Item> = {
      ...mockItem,
      viewerSubscription: 2 as any, // SubscriptionState.UNSUBSCRIBED
    };

    render(<PullRequestCard item={untrackedItem as Item} isSelected={false} onSelect={vi.fn()} />);
    const untrackedBadge = screen.getByTestId('untracked-badge');
    expect(untrackedBadge).toBeDefined();
    expect(untrackedBadge.textContent).toBe('Untracked');
    expect(untrackedBadge.getAttribute('title')).toContain('untracked');
  });

  it('renders latest assigned activity in preview row with actor', () => {
    const itemWithAssignedEvent: Partial<Item> = {
      ...mockProtoItem,
      stateEvents: [
        {
          type: 4, // ASSIGNED
          createdAt: { seconds: BigInt(1700000500), nanos: 0 },
          actor: { login: 'maintainer1', avatarUrl: '' },
        } as any,
      ],
    };

    render(<PullRequestCard item={itemWithAssignedEvent as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('maintainer1:')).toBeDefined();
    expect(screen.getByText('Assigned')).toBeDefined();
  });

  it('renders exact date-time tooltip on updated date', () => {
    const recentMs = Date.now() - 3600 * 1000;
    const itemWithUpdate: Partial<Item> = {
      ...mockItem,
      updatedAt: { seconds: BigInt(Math.floor(recentMs / 1000)), nanos: 0 } as any,
    };

    render(<PullRequestCard item={itemWithUpdate as Item} isSelected={false} onSelect={vi.fn()} />);
    const expectedExact = new Date(Math.floor(recentMs / 1000) * 1000).toLocaleString();
    const dateEl = screen.getByTitle(expectedExact);
    expect(dateEl).toBeDefined();
    expect(dateEl.textContent).toContain('hour ago');
  });

  it('renders latest non-noise activity timestamp on card when bot comments exist', () => {
    const humanTimeMs = Date.now() - 2 * 3600 * 1000; // 2 hours ago
    const botTimeMs = Date.now() - 60 * 1000; // 1 minute ago
    const itemWithBotNoise: Partial<Item> = {
      ...mockItem,
      createdAt: { seconds: BigInt(Math.floor((Date.now() - 5 * 86400 * 1000) / 1000)), nanos: 0 } as any,
      updatedAt: { seconds: BigInt(Math.floor(botTimeMs / 1000)), nanos: 0 } as any,
      comments: [
        {
          commentId: BigInt(1),
          bodyText: 'Human feedback',
          author: { login: 'alice', avatarUrl: '' } as any,
          createdAt: { seconds: BigInt(Math.floor(humanTimeMs / 1000)), nanos: 0 },
          noiseType: 0,
        } as any,
        {
          commentId: BigInt(2),
          bodyText: 'Bot build passed',
          author: { login: 'k8s-ci-robot', avatarUrl: '' } as any,
          createdAt: { seconds: BigInt(Math.floor(botTimeMs / 1000)), nanos: 0 },
          noiseType: 1,
        } as any,
      ],
    };

    render(<PullRequestCard item={itemWithBotNoise as Item} isSelected={false} onSelect={vi.fn()} />);
    const expectedExact = new Date(Math.floor(humanTimeMs / 1000) * 1000).toLocaleString();
    const dateEl = screen.getByTitle(expectedExact);
    expect(dateEl).toBeDefined();
    expect(dateEl.textContent).toContain('2 hours ago');
  });

  it('renders Draft badge and GitPullRequestDraft icon when PR is in draft state', () => {
    const draftPrItem: Partial<Item> = {
      ...mockItem,
      isDraft: true,
      state: ItemState.OPEN,
    };

    render(<PullRequestCard item={draftPrItem as Item} isSelected={false} onSelect={vi.fn()} />);
    const draftBadge = screen.getByTestId('draft-badge');
    expect(draftBadge).toBeDefined();
    expect(draftBadge.textContent).toContain('Draft');
    expect(draftBadge.getAttribute('title')).toBe('This pull request is in a draft state');

    const draftIcon = screen.getByLabelText('Draft Pull Request');
    expect(draftIcon).toBeDefined();
  });

  it('does not render Draft badge when PR is ready for review (isDraft: false)', () => {
    const readyPrItem: Partial<Item> = {
      ...mockItem,
      isDraft: false,
      state: ItemState.OPEN,
    };

    render(<PullRequestCard item={readyPrItem as Item} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.queryByTestId('draft-badge')).toBeNull();
    expect(screen.queryByLabelText('Draft Pull Request')).toBeNull();
  });

  it('renders red GitPullRequestClosed icon when PR is closed without merging', () => {
    const closedPrItem: Partial<Item> = {
      ...mockItem,
      state: ItemState.CLOSED,
    };

    const { container } = render(<PullRequestCard item={closedPrItem as Item} isSelected={false} onSelect={vi.fn()} />);
    const closedIcon = container.querySelector('.lucide-git-pull-request-closed');
    expect(closedIcon).not.toBeNull();
    expect(closedIcon?.classList.contains('text-red-600')).toBe(true);
    expect(container.querySelector('.lucide-git-merge')).toBeNull();
  });

  it('renders purple GitMerge icon when PR is merged', () => {
    const mergedPrItem: Partial<Item> = {
      ...mockItem,
      state: ItemState.MERGED,
    };

    const { container } = render(<PullRequestCard item={mergedPrItem as Item} isSelected={false} onSelect={vi.fn()} />);
    const mergedIcon = container.querySelector('.lucide-git-merge');
    expect(mergedIcon).not.toBeNull();
    expect(mergedIcon?.classList.contains('text-purple-600')).toBe(true);
    expect(container.querySelector('.lucide-git-pull-request-closed')).toBeNull();
  });

  it('applies focus styling when isFocused is true', () => {
    const { container } = render(
      <PullRequestCard
        item={mockItem as Item}
        isSelected={false}
        isFocused={true}
        onSelect={vi.fn()}
      />
    );
    const cardDiv = container.firstChild as HTMLElement;
    expect(cardDiv.className).toContain('border-l-blue-400');
    expect(cardDiv.className).not.toContain('ring-1');
  });

  it('triggers onAck without triggering onSelect when clicking quick ack button', () => {
    const onAck = vi.fn();
    const onSelect = vi.fn();
    render(
      <PullRequestCard
        item={mockItem as Item}
        isSelected={false}
        onSelect={onSelect}
        onAck={onAck}
      />
    );

    const ackBtn = screen.getByTestId('card-ack-btn');
    expect(ackBtn).toBeDefined();

    fireEvent.click(ackBtn);
    expect(onAck).toHaveBeenCalledWith(mockItem.id);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('triggers onUnack when clicking quick ack button on an acked item', () => {
    const onUnack = vi.fn();
    const onSelect = vi.fn();
    const ackedItem: Partial<Item> = {
      ...mockItem,
      local: { computedStatus: ItemStatus.ACKED, isAcked: true, privateNotes: '' } as any,
    };

    render(
      <PullRequestCard
        item={ackedItem as Item}
        isSelected={false}
        onSelect={onSelect}
        onUnack={onUnack}
        onAck={vi.fn()}
      />
    );

    const unackBtn = screen.getByTestId('card-ack-btn');
    fireEvent.click(unackBtn);
    expect(onUnack).toHaveBeenCalledWith(mockItem.id);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
