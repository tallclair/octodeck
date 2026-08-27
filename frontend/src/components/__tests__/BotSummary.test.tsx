import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BotSummary } from '../BotSummary';
import type { BotSummaryGroup } from '../../logic/noiseFilter';

describe('BotSummary', () => {
  const mockGroup: BotSummaryGroup = {
    type: 'BOT_SUMMARY',
    count: 2,
    hasFailure: false,
    timestamp: '2026-08-14T19:30:00Z',
    authors: ['k8s-ci-robot', 'linter-bot'],
    comments: [
      {
        bodyText: 'CI passed build #100',
        author: { login: 'k8s-ci-robot', avatarUrl: '' },
        createdAt: '2026-08-14T19:00:00Z',
        url: 'https://github.com/owner/repo/pull/1#issuecomment-1',
      },
      {
        bodyText: 'Linter passed',
        author: { login: 'linter-bot', avatarUrl: '' },
        createdAt: '2026-08-14T19:30:00Z',
      },
    ],
  };

  it('renders collapsed by default and expands on click', () => {
    render(<BotSummary group={mockGroup} />);
    expect(screen.getByText(/2 bot interactions hidden/)).toBeDefined();
    expect(screen.queryByText('CI passed build #100')).toBeNull();

    fireEvent.click(screen.getByText(/2 bot interactions hidden/));
    expect(screen.getByText('CI passed build #100')).toBeDefined();
    expect(screen.getByText('Linter passed')).toBeDefined();
  });

  it('renders exact date-time tooltip on expanded bot comments', () => {
    render(<BotSummary group={mockGroup} />);
    fireEvent.click(screen.getByText(/2 bot interactions hidden/));

    const expectedExact1 = new Date('2026-08-14T19:00:00Z').toLocaleString();
    const expectedExact2 = new Date('2026-08-14T19:30:00Z').toLocaleString();

    expect(screen.getByTitle(expectedExact1)).toBeDefined();
    expect(screen.getByTitle(expectedExact2)).toBeDefined();
  });
});
