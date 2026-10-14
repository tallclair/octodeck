// Test helpers for the query input (components/query/QueryInput.tsx). jsdom has no layout, so
// the hover remove button (which hit-tests pill fragments from getClientRects) needs a stubbed
// layout: pill i is one 20px-tall fragment at x = 30 + 60 * i, 50px wide, on the first line, in
// a 600x32 frame (1px border) at the viewport origin.
import { fireEvent, screen } from '@testing-library/react';

const PILL_LEFT = 30;
const PILL_STEP = 60;
const PILL_WIDTH = 50;
const PILL_TOP = 3;
const PILL_HEIGHT = 20;
const FRAME_HEIGHT = 32;

function pillRect(index: number): DOMRect {
  return new DOMRect(PILL_LEFT + index * PILL_STEP, PILL_TOP, PILL_WIDTH, PILL_HEIGHT);
}

/** Stubs pill and frame geometry; returns a function restoring the real jsdom methods. */
export function stubQueryPillLayout(): () => void {
  const originalRects = Element.prototype.getClientRects;
  const originalBox = Element.prototype.getBoundingClientRect;
  Element.prototype.getClientRects = function (this: Element) {
    const clause = this instanceof HTMLElement ? this.dataset.clause : undefined;
    if (clause === undefined) return originalRects.call(this);
    const rect = pillRect(Number(clause));
    return Object.assign([rect], { item: () => rect }) as unknown as DOMRectList;
  };
  const isFrame = (el: Element) =>
    el.getAttribute('role') === 'group' && el.getAttribute('aria-label') === 'Query';
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return isFrame(this) ? new DOMRect(0, 0, 600, FRAME_HEIGHT) : originalBox.call(this);
  };
  // The frame's padding box (inside its 1px border), which positions the remove button.
  const originalClient = {
    clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')!,
    clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!,
    clientTop: Object.getOwnPropertyDescriptor(Element.prototype, 'clientTop')!,
    clientLeft: Object.getOwnPropertyDescriptor(Element.prototype, 'clientLeft')!,
  };
  const frameClient = { clientHeight: FRAME_HEIGHT - 2, clientWidth: 598, clientTop: 1, clientLeft: 1 };
  for (const key of Object.keys(frameClient) as (keyof typeof frameClient)[]) {
    Object.defineProperty(Element.prototype, key, {
      configurable: true,
      get(this: Element) {
        return isFrame(this) ? frameClient[key] : originalClient[key].get!.call(this);
      },
    });
  }
  return () => {
    Element.prototype.getClientRects = originalRects;
    Element.prototype.getBoundingClientRect = originalBox;
    for (const [key, desc] of Object.entries(originalClient)) {
      Object.defineProperty(Element.prototype, key, desc);
    }
  };
}

/**
 * Moves the mouse over pill `index` (with stubQueryPillLayout active) and returns the revealed
 * remove button. Throws if no button appears (e.g. while the field is focused).
 */
export function hoverQueryPill(index: number): HTMLButtonElement {
  const frame = screen.getByRole('group', { name: 'Query' });
  const r = pillRect(index);
  fireEvent.mouseMove(frame, { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
  const button = frame.querySelector<HTMLButtonElement>(`[data-remove-clause="${index}"]`);
  if (!button) throw new Error(`no remove button for pill ${index}`);
  return button;
}

/** Removes the clause whose raw text is `raw` through its hover remove button. */
export function removeQueryClause(raw: string): void {
  const index = queryPillTexts().indexOf(raw);
  if (index < 0) throw new Error(`no pill for ${raw}`);
  fireEvent.click(hoverQueryPill(index));
}

/** Plain query text of every rendered pill, in order (display substitutes mapped back). */
export function queryPillTexts(): string[] {
  return screen
    .queryAllByTestId('query-pill')
    .map((p) => (p.textContent ?? '').replace(/\u2011/g, '-').replace(/\u2005/g, ' '));
}
