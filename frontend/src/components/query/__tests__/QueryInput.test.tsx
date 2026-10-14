import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryEditKind } from '../../../hooks/useDashboardFilters';
import type { QuerySuggestionFacets } from '../../../hooks/useQuerySuggestions';
import { NB_HYPHEN, THIN_SPACE, fromDisplay } from '../../../logic/query/displayText';
import { stubQueryPillLayout, hoverQueryPill } from '../../../test/queryInput';
import { QueryInput, type QueryInputProps } from '../QueryInput';

const FACETS: QuerySuggestionFacets = {
  labels: ['bug', 'good first issue', 'area/ui'],
  assignees: ['alice', 'bob'],
  authors: ['alice', 'charlie'],
  repos: ['octo/deck'],
};

type OnChange = QueryInputProps['onChange'];

function Harness({
  initial = '',
  invalidQuery = null,
  onChangeSpy,
  withOnClear = true,
}: {
  initial?: string;
  invalidQuery?: QueryInputProps['invalidQuery'];
  onChangeSpy?: OnChange;
  withOnClear?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <QueryInput
        value={value}
        facets={FACETS}
        invalidQuery={invalidQuery}
        onChange={(next, kind) => {
          setValue(next);
          onChangeSpy?.(next, kind);
        }}
        onClear={
          withOnClear
            ? () => {
                setValue('');
                onChangeSpy?.('', 'edit');
              }
            : undefined
        }
      />
      <button type="button" onClick={() => setValue('triage:acked state:closed')}>
        External Set
      </button>
    </div>
  );
}

const textarea = () => screen.getByRole('combobox') as HTMLTextAreaElement;
const pills = () => screen.queryAllByTestId('query-pill');
/** The painted box of pill `i` (its first fragment). */
const box = (i: number) => document.querySelector(`[data-pill-box="${i}"]`) as HTMLElement;

/** Types `value` (query text) with the caret at its end, like an input event from the browser. */
function type(el: HTMLTextAreaElement, value: string, caret = value.length) {
  fireEvent.change(el, { target: { value, selectionStart: caret, selectionEnd: caret } });
}

describe('QueryInput', () => {
  let restoreLayout: () => void;
  beforeEach(() => {
    restoreLayout = stubQueryPillLayout();
  });
  afterEach(() => {
    restoreLayout();
    vi.restoreAllMocks();
  });

  describe('text and display form', () => {
    it('is a native textarea showing the display form while reporting plain query text', () => {
      const spy = vi.fn<OnChange>();
      render(<Harness initial={'-author:k8s-ci-robot label:"good first issue"'} onChangeSpy={spy} />);
      const el = textarea();
      expect(el.tagName).toBe('TEXTAREA');
      expect(el.value).toBe(
        `${NB_HYPHEN}author:k8s${NB_HYPHEN}ci${NB_HYPHEN}robot label:"good${THIN_SPACE}first${THIN_SPACE}issue"`
      );
      expect(el.getAttribute('spellcheck')).toBe('false');
      expect(el.getAttribute('autocorrect')).toBe('off');
      expect(el.getAttribute('autocapitalize')).toBe('off');

      type(el, `${el.value} is:pr`);
      expect(spy).toHaveBeenLastCalledWith('-author:k8s-ci-robot label:"good first issue" is:pr', 'typing');
      expect(fromDisplay(el.value)).toBe('-author:k8s-ci-robot label:"good first issue" is:pr');
    });

    it('emits normalised text but keeps the spaces the user is typing', () => {
      const spy = vi.fn<OnChange>();
      render(<Harness onChangeSpy={spy} />);
      const el = textarea();
      fireEvent.focus(el);
      type(el, 'is:open ');
      expect(spy).toHaveBeenLastCalledWith('is:open', 'typing');
      expect(el.value).toBe('is:open ');
      spy.mockClear();
      type(el, 'is:open  ');
      expect(spy).not.toHaveBeenCalled();
      type(el, 'is:open  label:bug');
      expect(spy).toHaveBeenLastCalledWith('is:open label:bug', 'typing');
      expect(el.value).toBe('is:open  label:bug');
    });

    it('turns pasted newlines into spaces', () => {
      const spy = vi.fn<OnChange>();
      render(<Harness onChangeSpy={spy} />);
      type(textarea(), 'is:pr\nis:open\r\n-label:x');
      expect(spy).toHaveBeenLastCalledWith('is:pr is:open -label:x', 'typing');
      expect(textarea().value).toBe(`is:pr is:open ${NB_HYPHEN}label:x`);
    });

    it('copies and cuts plain text, never the display substitutes', () => {
      render(<Harness initial={'label:"a b" -x'} />);
      const el = textarea();
      el.setSelectionRange(0, el.value.length);
      const setData = vi.fn();
      fireEvent.copy(el, { clipboardData: { setData } });
      expect(setData).toHaveBeenCalledWith('text/plain', 'label:"a b" -x');

      const spy = vi.fn();
      el.setSelectionRange(0, 12);
      fireEvent.cut(el, { clipboardData: { setData: spy } });
      expect(spy).toHaveBeenCalledWith('text/plain', 'label:"a b" ');
      expect(fromDisplay(el.value)).toBe('-x');
    });
  });

  describe('controlled value', () => {
    it('adopts an external value even while focused with unsaved spacing', () => {
      render(<Harness initial="is:open" />);
      const el = textarea();
      fireEvent.focus(el);
      type(el, 'is:open   ');
      fireEvent.click(screen.getByRole('button', { name: 'External Set' }));
      expect(el.value).toBe('triage:acked state:closed');
      expect(pills().map((p) => p.textContent)).toEqual(['triage:acked', 'state:closed']);
    });

    it('keeps local text when the parent echoes the normalised form', () => {
      render(<Harness initial="" />);
      const el = textarea();
      type(el, '"a  b"   c ');
      expect(el.value).toBe(`"a${THIN_SPACE}${THIN_SPACE}b"   c `);
    });
  });

  describe('keyboard', () => {
    it('never inserts a newline on Enter and moves the caret to the end', () => {
      render(<Harness initial="is:pr label:bug" />);
      const el = textarea();
      fireEvent.focus(el);
      el.setSelectionRange(2, 2);
      expect(fireEvent.keyDown(el, { key: 'Enter' })).toBe(false);
      expect(el.selectionStart).toBe(el.value.length);
      expect(fireEvent.keyDown(el, { key: 'Enter', shiftKey: true })).toBe(false);
      expect(el.value).toBe('is:pr label:bug');
    });

    it('blocks line-break beforeinput events', () => {
      render(<Harness initial="is:pr" />);
      const ev = new InputEvent('beforeinput', { inputType: 'insertLineBreak', cancelable: true });
      textarea().dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    });

    it('plans a typed space inside quotes as a thin space in beforeinput', () => {
      const spy = vi.fn<OnChange>();
      render(<Harness initial={'label:"a"'} onChangeSpy={spy} />);
      const el = textarea();
      el.setSelectionRange(8, 8);
      const ev = new InputEvent('beforeinput', { inputType: 'insertText', data: ' ', cancelable: true });
      act(() => {
        el.dispatchEvent(ev);
      });
      expect(ev.defaultPrevented).toBe(true);
      expect(el.value).toBe(`label:"a${THIN_SPACE}"`);
      expect(el.selectionStart).toBe(9);
      expect(spy).toHaveBeenLastCalledWith('label:"a "', 'typing');
    });

    it('lets Tab move focus when no suggestions are open', () => {
      render(<Harness initial="flaky" />);
      const el = textarea();
      fireEvent.focus(el);
      expect(fireEvent.keyDown(el, { key: 'Tab' })).toBe(true);
    });

    it('closes suggestions on the first Escape and leaves the field on the next', () => {
      render(<Harness />);
      const el = textarea();
      el.focus();
      fireEvent.keyDown(el, { key: 'ArrowDown' });
      expect(screen.getByRole('listbox')).toBeTruthy();
      fireEvent.keyDown(el, { key: 'Escape' });
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(document.activeElement).toBe(el);
      type(el, 'flaky');
      expect(fireEvent.keyDown(el, { key: 'Escape' })).toBe(false);
      expect(document.activeElement).not.toBe(el);
      expect(el.value).toBe('flaky');
    });

    it('ignores keys during IME composition and re-syncs on compositionend', () => {
      const spy = vi.fn<OnChange>();
      render(<Harness onChangeSpy={spy} />);
      const el = textarea();
      fireEvent.focus(el);
      fireEvent.compositionStart(el);
      type(el, 'label:a-b');
      expect(fireEvent.keyDown(el, { key: 'Enter', isComposing: true, keyCode: 229 })).toBe(true);
      expect(el.value).toBe('label:a-b');
      fireEvent.compositionEnd(el);
      expect(el.value).toBe(`label:a${NB_HYPHEN}b`);
      expect(spy).toHaveBeenLastCalledWith('label:a-b', 'typing');
    });

    it('emits native undo/redo as edits', () => {
      const spy = vi.fn<OnChange>();
      render(<Harness initial="is:open" onChangeSpy={spy} />);
      const el = textarea();
      fireEvent.input(el, { target: { value: '' }, inputType: 'historyUndo' });
      expect(spy).toHaveBeenLastCalledWith('', 'edit');
    });
  });

  describe('suggestions', () => {
    it('completes keys with Tab or Enter and finishes a value with Enter', () => {
      const spy = vi.fn<OnChange>();
      render(<Harness onChangeSpy={spy} />);
      const el = textarea();
      el.focus();
      fireEvent.focus(el);
      expect(screen.queryByRole('listbox')).toBeNull();
      fireEvent.keyDown(el, { key: 'ArrowDown' });
      expect(screen.getByRole('listbox')).toBeTruthy();
      fireEvent.keyDown(el, { key: 'Escape' });

      type(el, 'la');
      expect(el.getAttribute('aria-expanded')).toBe('true');
      fireEvent.keyDown(el, { key: 'Enter' });
      expect(el.value).toBe('label:');
      expect(el.selectionStart).toBe(6);

      // Value list: area/ui, bug, good first issue. Tab completes without finishing.
      fireEvent.keyDown(el, { key: 'ArrowDown' });
      fireEvent.keyDown(el, { key: 'Tab' });
      expect(el.value).toBe('label:bug');

      type(el, 'label:bug,');
      fireEvent.keyDown(el, { key: 'Enter' });
      expect(el.value).toBe('label:bug,area/ui ');
      expect(el.selectionStart).toBe(18);
      expect(spy).toHaveBeenLastCalledWith('label:bug,area/ui', 'typing');
    });

    it('suggests over the full text at the caret and quotes values with spaces', () => {
      render(<Harness initial="is:open" />);
      const el = textarea();
      el.focus();
      fireEvent.focus(el);
      type(el, 'label:go is:open', 8);
      fireEvent.keyDown(el, { key: 'Enter' });
      expect(fromDisplay(el.value)).toBe('label:"good first issue" is:open');
    });

    it('picks a suggestion with the mouse', () => {
      render(<Harness />);
      const el = textarea();
      el.focus();
      fireEvent.focus(el);
      type(el, 'assignee:');
      fireEvent.click(screen.getByRole('option', { name: /bob/ }));
      expect(el.value).toBe('assignee:bob ');
    });
  });

  describe('pills', () => {
    it('gives every clause a pill with its tone, including free text', () => {
      render(<Harness initial="is:open -label:kind/bug lable:x label: flaky -wip" />);
      expect(pills().map((p) => [p.textContent, p.dataset.tone])).toEqual([
        ['is:open', 'ok'],
        [`${NB_HYPHEN}label:kind/bug`, 'negated'],
        ['lable:x', 'error'],
        ['label:', 'incomplete'],
        ['flaky', 'term'],
        [`${NB_HYPHEN}wip`, 'negatedTerm'],
      ]);
    });

    it('distinguishes errors from negation and never uses strikethrough', () => {
      const { container } = render(<Harness initial="lable:bug -label:x state:nope" />);
      const [unknownKey, negated, badValue] = pills();
      expect(unknownKey.dataset.status).toBe('error');
      expect(negated.dataset.status).toBe('ok');
      expect(negated.dataset.negated).toBe('true');
      expect(box(0).className).toContain('red');
      expect(box(1).className).toContain('rose');
      expect(box(1).className).not.toContain('red-');
      // The wavy underline marks the bad key or value, not the whole pill.
      expect(unknownKey.querySelector('.decoration-wavy')?.textContent).toBe('lable');
      expect(badValue.querySelector('.decoration-wavy')?.textContent).toBe('nope');
      container.querySelectorAll('*').forEach((el) => {
        expect(el.getAttribute('class') ?? '').not.toContain('line-through');
        expect(el.getAttribute('class') ?? '').not.toMatch(/\bfont-(medium|semibold|bold)\b/);
      });
    });

    it('keeps every pill fill on focus and only drops the border, except on the caret clause', () => {
      render(<Harness initial="is:open label:bug" />);
      const el = textarea();
      const [first, second] = [box(0), box(1)];
      expect(first.className).toContain('border-blue-200');
      expect(second.className).toContain('border-blue-200');
      const fill = second.className.split(' ').filter((c) => c.includes('bg-'));
      expect(fill.length).toBeGreaterThan(0);
      const before = second.getAttribute('style');
      el.setSelectionRange(2, 2);
      fireEvent.focus(el);
      expect(first.className).toContain('border-blue-200');
      expect(second.className).toContain('border-transparent');
      expect(second.className.split(' ').filter((c) => c.includes('bg-'))).toEqual(fill);
      expect(first.className.split(' ').filter((c) => c.includes('bg-'))).toEqual(fill);
      // The pill boxes are reused and keep their geometry, so nothing re-mounts or moves.
      expect(box(1)).toBe(second);
      expect(second.getAttribute('style')).toBe(before);
      fireEvent.blur(el);
      expect(second.className).toContain('border-blue-200');
    });

    it('shows an incomplete clause neutrally while the caret is inside it', () => {
      render(<Harness />);
      const el = textarea();
      fireEvent.focus(el);
      type(el, 'label:');
      expect(pills()[0].dataset.tone).toBe('draft');
      fireEvent.blur(el);
      expect(pills()[0].dataset.tone).toBe('incomplete');
    });

    it('keeps the decoration layer out of the accessibility tree', () => {
      render(<Harness initial="is:open" />);
      const layer = screen.getByTestId('query-decorations');
      expect(layer.closest('[aria-hidden="true"]')).not.toBeNull();
    });
  });

  describe('inset remove x', () => {
    it('appears on mouse hover at rest over the pill trailing glyphs and removes the clause', () => {
      const spy = vi.fn<OnChange>();
      render(<Harness initial="is:pr label:bug is:open" onChangeSpy={spy} />);
      const el = textarea();
      expect(screen.queryByRole('button', { name: /^Remove /, hidden: true })).toBeNull();

      const x = hoverQueryPill(1);
      expect(x.getAttribute('aria-label')).toBe('Remove label:bug');
      expect(x.tabIndex).toBe(-1);
      expect(x.closest('[aria-hidden="true"]')).not.toBeNull();
      // The x lives in a copy of the pill's last box (same geometry, transparent border), pinned
      // to the right of its padding box, so CSS keeps it inside the border and centred.
      const overlay = x.parentElement as HTMLElement;
      expect(overlay.getAttribute('style')).toBe(box(1).getAttribute('style'));
      expect(overlay.className).toContain('border-transparent');
      expect(x.className).toMatch(/\binset-y-0\b/);
      expect(x.className).toMatch(/\bright-0\b/);
      expect(x.querySelector('.rounded-full')?.className).toContain('group-hover/x:bg-blue-200');

      expect(fireEvent.mouseDown(x)).toBe(false);
      fireEvent.click(x);
      expect(spy).toHaveBeenLastCalledWith('is:pr is:open', 'edit');
      expect(el.value).toBe('is:pr is:open');
      expect(document.activeElement).not.toBe(el);
      expect(screen.getByRole('status').textContent).toBe('Removed label:bug');
    });

    it('hides on mouse leave and stays while the pointer is on the x', () => {
      render(<Harness initial="is:pr label:bug" />);
      const x = hoverQueryPill(0);
      fireEvent.mouseMove(x, { clientX: 300, clientY: 100 });
      expect(screen.getByRole('button', { name: 'Remove is:pr', hidden: true })).toBe(x);
      fireEvent.mouseLeave(screen.getByRole('group', { name: 'Query' }));
      expect(screen.queryByRole('button', { name: /^Remove /, hidden: true })).toBeNull();
    });

    it('never shows while the field is focused, and focusing hides it', () => {
      render(<Harness initial="is:pr label:bug" />);
      hoverQueryPill(0);
      fireEvent.focus(textarea());
      expect(screen.queryByRole('button', { name: /^Remove /, hidden: true })).toBeNull();
      expect(() => hoverQueryPill(1)).toThrow();
    });

    it('is not caret-triggered', () => {
      render(<Harness initial="is:pr label:bug" />);
      const el = textarea();
      el.setSelectionRange(9, 9);
      fireEvent.select(el);
      fireEvent.blur(el);
      expect(screen.queryByRole('button', { name: /^Remove /, hidden: true })).toBeNull();
    });
  });

  describe('clear all', () => {
    it('clears the whole query including tab clauses via onClear', () => {
      const spy = vi.fn<OnChange>();
      render(<Harness initial="triage:acked new:any label:bug" onChangeSpy={spy} />);
      const clear = screen.getByRole('button', { name: 'Clear query' });
      expect(fireEvent.mouseDown(clear)).toBe(false);
      fireEvent.click(clear);
      expect(textarea().value).toBe('');
      expect(spy).toHaveBeenLastCalledWith('', 'edit');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status').textContent).toBe('Query cleared');
      expect(screen.queryByRole('button', { name: 'Clear query' })).toBeNull();
    });

    it('falls back to onChange with an edit when there is no onClear, also while focused', () => {
      const spy = vi.fn<OnChange>();
      render(<Harness initial="label:bug" onChangeSpy={spy} withOnClear={false} />);
      const el = textarea();
      el.focus();
      fireEvent.click(screen.getByRole('button', { name: 'Clear query' }));
      expect(el.value).toBe('');
      expect(spy.mock.calls).toEqual([['', 'edit']]);
      expect(document.activeElement).toBe(el);
    });
  });

  describe('errors and accessibility', () => {
    it('exposes combobox ARIA, a description with the query and the placeholder', () => {
      const { container } = render(<Harness />);
      const group = screen.getByRole('group', { name: 'Query' });
      const el = textarea();
      expect(group.contains(el)).toBe(true);
      expect(el.getAttribute('aria-label')).toBe('Filter or search query');
      expect(el.getAttribute('aria-autocomplete')).toBe('list');
      expect(el.getAttribute('aria-expanded')).toBe('false');
      // Native placeholder, with U+2005 spaces so the clause-gutter word spacing doesn't widen it.
      expect(el.getAttribute('placeholder')).toBe('Filter\u2005or\u2005search,\u2005e.g.\u2005is:open\u2005label:bug');
      expect(el.getAttribute('placeholder')).not.toContain(' ');
      expect(container.querySelector('[data-testid="query-placeholder"]')).toBeNull();
      const desc = () => document.getElementById(el.getAttribute('aria-describedby')!)?.textContent;
      expect(desc()).toBe('Current query: empty');
      type(el, 'label:bug  ');
      expect(desc()).toBe('Current query: label:bug');
    });

    it('hides the caret clause issue while focused and shows the summary on blur', () => {
      render(<Harness />);
      const el = textarea();
      fireEvent.focus(el);
      type(el, 'label:');
      expect(screen.queryByTestId('invalid-query')).toBeNull();
      expect(el.hasAttribute('aria-invalid')).toBe(false);
      fireEvent.blur(el);
      expect(screen.getByTestId('invalid-query').textContent).toBe(
        '1 part of the query is ignored: Missing value for label:'
      );
      expect(el.getAttribute('aria-invalid')).toBe('true');
    });

    it('announces an issue once the caret leaves the bad clause', () => {
      render(<Harness />);
      const el = textarea();
      fireEvent.focus(el);
      type(el, 'lable:bug');
      expect(screen.getByRole('status').textContent).toBe('');
      type(el, 'lable:bug ');
      expect(screen.getByRole('status').textContent).toMatch(/lable is not a known filter/);
    });

    it('maps a server ExprError to its clause, styles it as an error and announces it', () => {
      const onChange = vi.fn<OnChange>();
      const { rerender } = render(<QueryInput value="is:open state:merged" onChange={onChange} />);
      expect(pills()[1].dataset.status).toBe('ok');
      rerender(
        <QueryInput
          value="is:open state:merged"
          onChange={onChange}
          invalidQuery={{ path: 'and.exprs[1]', message: 'state "merged" is not supported here' }}
        />
      );
      expect(pills()[1].dataset.status).toBe('error');
      expect(pills()[1].dataset.tone).toBe('error');
      expect(pills()[0].dataset.status).toBe('ok');
      expect(screen.getByRole('status').textContent).toBe('state "merged" is not supported here');
      expect(screen.getByTestId('invalid-query').textContent).toBe(
        '1 part of the query is ignored: state "merged" is not supported here'
      );
    });

    it('re-announces identical messages by remounting the live-region child', () => {
      render(<Harness initial="a b" />);
      const status = screen.getByRole('status');
      fireEvent.click(hoverQueryPill(0));
      const first = status.firstElementChild;
      expect(status.textContent).toBe('Removed a');
      fireEvent.click(screen.getByRole('button', { name: 'External Set' }));
      fireEvent.click(screen.getByRole('button', { name: 'Clear query' }));
      expect(status.textContent).toBe('Query cleared');
      fireEvent.click(screen.getByRole('button', { name: 'External Set' }));
      fireEvent.click(screen.getByRole('button', { name: 'Clear query' }));
      expect(status.textContent).toBe('Query cleared');
      expect(status.firstElementChild).not.toBe(first);
    });
  });

  it('forwards the textarea ref', () => {
    const ref = { current: null as HTMLTextAreaElement | null };
    render(<QueryInput value="" onChange={vi.fn<(t: string, k: QueryEditKind) => void>()} inputRef={ref} />);
    expect(ref.current).toBe(textarea());
  });
});
