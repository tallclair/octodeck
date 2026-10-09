import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import TokenizedInput from './TokenizedInput';

// Sanity checks for the chip/draft state machine (jsdom; no real layout).
describe('prototype TokenizedInput', () => {
  const setup = (initial: string) => {
    const onChange = vi.fn();
    const r = render(<TokenizedInput initial={initial} onChange={onChange} />);
    const input = r.container.querySelector('input')!;
    const last = () => onChange.mock.calls.at(-1)?.[0];
    return { ...r, input, last };
  };

  it('space finishes a token, quotes keep it open', () => {
    const { input, last } = setup('');
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'label:"good first' } });
    expect(input.value).toBe('label:"good first');
    fireEvent.change(input, { target: { value: 'label:"good first issue" ' } });
    expect(input.value).toBe('');
    expect(last()).toBe('label:"good first issue"');
  });

  it('backspace at start opens the previous chip with caret at end', () => {
    const { input, last } = setup('is:open repo:a/b');
    act(() => input.focus());
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(input.value).toBe('repo:a/b');
    expect(input.selectionStart).toBe(8);
    expect(last()).toBe('is:open repo:a/b');
  });

  it('arrow keys walk across chips, re-chipping the draft', () => {
    const { input, last } = setup('a b c');
    act(() => input.focus());
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: 'ArrowLeft' }); // opens c
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: 'ArrowLeft' }); // opens b
    expect(input.value).toBe('b');
    expect(last()).toBe('a b c');
    fireEvent.change(input, { target: { value: 'bx' } });
    expect(last()).toBe('a bx c');
  });

  it('pasting a full query chips all but the token under the caret', () => {
    const { input, last } = setup('');
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'is:open new:mention,code flaky' } });
    expect(input.value).toBe('flaky');
    expect(last()).toBe('is:open new:mention,code flaky');
  });
});
