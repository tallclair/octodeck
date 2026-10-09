import { describe, it, expect } from 'vitest';
import { render, renderHook, act, fireEvent, screen } from '@testing-library/react';
import { useMenuGroup } from '../useMenuGroup';

type TestMenuId = 'repo' | 'author' | 'label';

function TestHarness() {
  const menus = useMenuGroup<TestMenuId>();
  return (
    <div>
      <div data-testid="outside">Outside</div>
      {(['repo', 'author', 'label'] as const).map((id) => (
        <div key={id} ref={menus.refFor(id)} data-testid={`wrap-${id}`}>
          <button type="button" onClick={() => menus.toggle(id)}>
            Toggle {id}
          </button>
          {menus.isOpen(id) && <div data-testid={`panel-${id}`}>Panel {id}</div>}
        </div>
      ))}
    </div>
  );
}

describe('useMenuGroup', () => {
  it('starts closed with anyOpen = false', () => {
    const { result } = renderHook(() => useMenuGroup<TestMenuId>());
    expect(result.current.open).toBeNull();
    expect(result.current.anyOpen).toBe(false);
    expect(result.current.isOpen('repo')).toBe(false);
  });

  it('opens one menu and closes others when toggled directly without mousedown', () => {
    const { result } = renderHook(() => useMenuGroup<TestMenuId>());

    act(() => {
      result.current.toggle('repo');
    });
    expect(result.current.open).toBe('repo');
    expect(result.current.anyOpen).toBe(true);
    expect(result.current.isOpen('repo')).toBe(true);
    expect(result.current.isOpen('author')).toBe(false);

    // Toggling another menu closes 'repo' even without a DOM mousedown event.
    act(() => {
      result.current.toggle('author');
    });
    expect(result.current.open).toBe('author');
    expect(result.current.isOpen('repo')).toBe(false);
    expect(result.current.isOpen('author')).toBe(true);

    // Toggling the same menu closes it.
    act(() => {
      result.current.toggle('author');
    });
    expect(result.current.open).toBeNull();
    expect(result.current.anyOpen).toBe(false);
  });

  it('closes the open menu on Escape', () => {
    const { result } = renderHook(() => useMenuGroup<TestMenuId>());

    act(() => {
      result.current.openMenu('label');
    });
    expect(result.current.isOpen('label')).toBe(true);

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(result.current.open).toBeNull();
    expect(result.current.anyOpen).toBe(false);
  });

  it('closes on outside pointer-down and stays open on inside pointer-down', () => {
    render(<TestHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle repo' }));
    expect(screen.getByTestId('panel-repo')).toBeDefined();

    // Clicking inside the active menu container keeps it open.
    fireEvent.mouseDown(screen.getByTestId('panel-repo'));
    expect(screen.getByTestId('panel-repo')).toBeDefined();

    // Pointer-down outside closes it.
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByTestId('panel-repo')).toBeNull();
  });

  it('returns stable per-id refs across renders', () => {
    const { result, rerender } = renderHook(() => useMenuGroup<TestMenuId>());
    const repoRef1 = result.current.refFor('repo');
    const authorRef1 = result.current.refFor('author');

    act(() => {
      result.current.toggle('repo');
    });
    rerender();

    expect(result.current.refFor('repo')).toBe(repoRef1);
    expect(result.current.refFor('author')).toBe(authorRef1);
    expect(repoRef1).not.toBe(authorRef1);
  });
});
