// Pure geometry for the query input's pills. The component reads where each clause's glyphs
// render (getClientRects) and these functions decide where the pill boxes are painted and which
// pill the mouse is over, so the rules are unit-testable without a layout engine.

export interface RelRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The line fragments of one clause pill (a wrapped pill has one per line). */
export interface PillFragments {
  readonly index: number;
  readonly rects: readonly RelRect[];
}

/** How far (px) outside a pill fragment the pointer still counts as hovering it. */
export const PILL_HIT_SLOP = 2;

/** Index of the pill under (x, y), or null. The point and fragments share one coordinate space. */
export function pillAtPoint(pills: readonly PillFragments[], x: number, y: number): number | null {
  for (const pill of pills) {
    const hit = pill.rects.some(
      (r) =>
        x >= r.left - PILL_HIT_SLOP &&
        x <= r.right + PILL_HIT_SLOP &&
        y >= r.top - PILL_HIT_SLOP &&
        y <= r.bottom + PILL_HIT_SLOP
    );
    if (hit) return pill.index;
  }
  return null;
}

/**
 * One painted pill box: a pill fragment's surface (tint and border) in the decoration layer's
 * coordinates. A pill that wraps has one box per line; only its outer ends are rounded and
 * bordered.
 */
export interface PillBox {
  readonly index: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** First fragment of the pill (owns its left end). */
  readonly first: boolean;
  /** Last fragment of the pill (owns its right end, and the remove button). */
  readonly last: boolean;
}

export interface PillMetrics {
  /** Text line height (px). */
  readonly lineHeight: number;
  /** Text box padding above the first line (px). */
  readonly padTop: number;
  /** Painted pill height (px), centred in its line. */
  readonly pillHeight: number;
  /** Horizontal room between the glyphs and the pill's border (px). */
  readonly padX: number;
  /** Pill border width (px). */
  readonly border: number;
}

/**
 * Pill boxes from the glyph rects of each clause (getClientRects of the clause's inline text,
 * relative to the decoration layer; several rects on one line are merged into one run). The vertical position comes from the line box, not
 * from font metrics: each fragment is assigned to the line its glyphs' midpoint falls in and the
 * box is centred in that line with an explicit height, so every pill has the same height and
 * vertical position at any font or zoom. Horizontally the box wraps the glyphs plus padding and
 * border on its outer ends.
 */
export function pillBoxes(pills: readonly PillFragments[], m: PillMetrics): PillBox[] {
  const boxes: PillBox[] = [];
  const outer = m.padX + m.border;
  for (const pill of pills) {
    // One run per line: getClientRects of an undecorated inline element can return several
    // rects per line (one per child text run), so merge rects that share a line.
    const runs: { line: number; left: number; right: number }[] = [];
    for (const r of pill.rects) {
      if (r.right <= r.left) continue;
      const mid = (r.top + r.bottom) / 2;
      const line = Math.max(0, Math.floor((mid - m.padTop) / m.lineHeight));
      const run = runs.find((x) => x.line === line);
      if (run) {
        run.left = Math.min(run.left, r.left);
        run.right = Math.max(run.right, r.right);
      } else {
        runs.push({ line, left: r.left, right: r.right });
      }
    }
    runs.sort((a, b) => a.line - b.line);
    runs.forEach((run, j) => {
      const first = j === 0;
      const last = j === runs.length - 1;
      const left = run.left - (first ? outer : 0);
      const right = run.right + (last ? outer : 0);
      boxes.push({
        index: pill.index,
        left,
        top: m.padTop + run.line * m.lineHeight + (m.lineHeight - m.pillHeight) / 2,
        width: right - left,
        height: m.pillHeight,
        first,
        last,
      });
    });
  }
  return boxes;
}

/** Boxes as hit-test fragments (pillAtPoint), grouped per pill. */
export function boxFragments(boxes: readonly PillBox[]): PillFragments[] {
  const byIndex = new Map<number, RelRect[]>();
  for (const b of boxes) {
    const rects = byIndex.get(b.index) ?? [];
    rects.push({ left: b.left, top: b.top, right: b.left + b.width, bottom: b.top + b.height });
    byIndex.set(b.index, rects);
  }
  return Array.from(byIndex, ([index, rects]) => ({ index, rects }));
}

/**
 * Left offset (px, relative to the frame) for the suggestion popup anchored under the token
 * being completed (`anchorLeft`), shifted left by `inset` so the option text lines up with the
 * token, and clamped so a `popupWidth` wide popup stays inside a `frameWidth` wide frame.
 */
export function popupLeft(
  anchorLeft: number,
  frameWidth: number,
  popupWidth: number,
  inset: number
): number {
  return Math.max(0, Math.min(anchorLeft - inset, frameWidth - popupWidth));
}
