import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PinButton } from '../PinButton';
import { toView } from '../../../logic/savedSearches';

describe('PinButton component', () => {
  it('is disabled for empty queries with appropriate tooltip', () => {
    const onClick = vi.fn();
    render(<PinButton queryText="" onClick={onClick} />);

    const button = screen.getByTestId('pin-search-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('data-active')).toBe('false');
    expect(button.getAttribute('title')).toBe('The Inbox is always in the sidebar');

    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is disabled for queries with parse issues or server error', () => {
    const onClick = vi.fn();
    const { rerender } = render(<PinButton queryText="state:bogus" onClick={onClick} />);

    let button = screen.getByTestId('pin-search-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('Fix the highlighted parts of the query first');

    rerender(<PinButton queryText="repo:kubernetes/kubernetes" hasServerError={true} onClick={onClick} />);
    button = screen.getByTestId('pin-search-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('is enabled and unfilled for an unpinned valid query', () => {
    const onClick = vi.fn();
    render(<PinButton queryText="repo:kubernetes/kubernetes is:open" onClick={onClick} />);

    const button = screen.getByTestId('pin-search-button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('data-active')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Pin search');

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is filled and active when matching a saved search', () => {
    const search = toView({
      id: 's1',
      name: 'K8s Bugs',
      query: 'repo:kubernetes/kubernetes label:kind/bug',
    });
    const onClick = vi.fn();

    render(
      <PinButton
        queryText="repo:kubernetes/kubernetes label:kind/bug"
        searches={[search]}
        onClick={onClick}
      />
    );

    const button = screen.getByTestId('pin-search-button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('data-active')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Edit pinned search K8s Bugs');

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is modified and outlined when query has diverged from origin search', () => {
    const search = toView({
      id: 's1',
      name: 'K8s Bugs',
      query: 'repo:kubernetes/kubernetes label:kind/bug',
    });
    const onClick = vi.fn();

    render(
      <PinButton
        queryText="repo:kubernetes/kubernetes label:kind/bug is:issue"
        originSearch={search}
        isOriginModified={true}
        onClick={onClick}
      />
    );

    const button = screen.getByTestId('pin-search-button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('data-active')).toBe('modified');
    expect(button.getAttribute('aria-label')).toBe('Update pinned search K8s Bugs');

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
