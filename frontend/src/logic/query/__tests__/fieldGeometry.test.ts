import { describe, expect, it } from 'vitest';
import { boxFragments, pillAtPoint, pillBoxes, popupLeft } from '../fieldGeometry';

describe('pillAtPoint', () => {
  const pills = [
    { index: 0, rects: [{ left: 30, top: 2, right: 80, bottom: 22 }] },
    // A pill wrapped over two lines.
    {
      index: 1,
      rects: [
        { left: 90, top: 2, right: 200, bottom: 22 },
        { left: 30, top: 26, right: 70, bottom: 46 },
      ],
    },
  ];

  it('finds the pill under the pointer, including any wrapped fragment', () => {
    expect(pillAtPoint(pills, 50, 10)).toBe(0);
    expect(pillAtPoint(pills, 150, 10)).toBe(1);
    expect(pillAtPoint(pills, 40, 30)).toBe(1);
  });

  it('allows a small slop and misses in the gaps', () => {
    expect(pillAtPoint(pills, 81, 10)).toBe(0);
    expect(pillAtPoint(pills, 85, 10)).toBeNull();
    expect(pillAtPoint(pills, 150, 35)).toBeNull();
  });
});

describe('pillBoxes', () => {
  const m = { lineHeight: 28, padTop: 1, pillHeight: 22, padX: 3.5, border: 1 };

  it('centres every box in its line with an explicit height, whatever the glyph metrics', () => {
    // Glyph content areas of different fonts / zooms: fractional and asymmetric in the line.
    const glyphs = [
      { top: 6.2, bottom: 23.1 },
      { top: 5.4, bottom: 24.8 },
      { top: 7.75, bottom: 22.3 },
    ];
    for (const g of glyphs) {
      const [box] = pillBoxes([{ index: 0, rects: [{ left: 40.3, right: 90.6, ...g }] }], m);
      expect(box.top).toBe(4); // padTop 1 + (28 - 22) / 2
      expect(box.height).toBe(22);
    }
  });

  it('wraps the glyphs plus padding and border horizontally', () => {
    const [box] = pillBoxes([{ index: 3, rects: [{ left: 40, top: 6, right: 90, bottom: 23 }] }], m);
    expect(box).toEqual({ index: 3, left: 35.5, top: 4, width: 59, height: 22, first: true, last: true });
  });

  it('splits a wrapped pill into open-ended boxes on consecutive lines', () => {
    const boxes = pillBoxes(
      [
        {
          index: 1,
          rects: [
            { left: 200, top: 6, right: 280, bottom: 23 },
            { left: 30, top: 34, right: 70, bottom: 51 },
            { left: 30, top: 62, right: 50, bottom: 79 },
          ],
        },
      ],
      m
    );
    expect(boxes.map((b) => [b.top, b.first, b.last])).toEqual([
      [4, true, false],
      [32, false, false],
      [60, false, true],
    ]);
    // Only the outer ends get padding and border.
    expect(boxes[0]).toMatchObject({ left: 195.5, width: 84.5 });
    expect(boxes[1]).toMatchObject({ left: 30, width: 40 });
    expect(boxes[2]).toMatchObject({ left: 30, width: 24.5 });
  });

  it('merges several glyph rects on one line (child text runs) into one box', () => {
    const boxes = pillBoxes(
      [
        {
          index: 0,
          rects: [
            { left: 40, top: 6, right: 52, bottom: 23 },
            { left: 52, top: 6, right: 56, bottom: 23 },
            { left: 56, top: 6, right: 90, bottom: 23 },
            { left: 30, top: 34, right: 60, bottom: 51 },
            { left: 60, top: 34, right: 64, bottom: 51 },
          ],
        },
      ],
      m
    );
    expect(boxes.map((b) => [b.left, b.top, b.width, b.first, b.last])).toEqual([
      [35.5, 4, 54.5, true, false],
      [30, 32, 38.5, false, true],
    ]);
  });

  it('feeds hit-testing through the painted boxes', () => {
    const boxes = pillBoxes(
      [
        { index: 0, rects: [{ left: 40, top: 6, right: 90, bottom: 23 }] },
        { index: 1, rects: [{ left: 100, top: 6, right: 150, bottom: 23 }] },
      ],
      m
    );
    const frags = boxFragments(boxes);
    expect(pillAtPoint(frags, 36, 5)).toBe(0); // in the padding, above the glyphs
    expect(pillAtPoint(frags, 120, 25)).toBe(1);
    expect(pillAtPoint(frags, 120, 30)).toBeNull();
  });
});

describe('popupLeft', () => {
  it('shifts by the inset and clamps inside the frame', () => {
    expect(popupLeft(100, 600, 320, 12)).toBe(88);
    expect(popupLeft(5, 600, 320, 12)).toBe(0);
    expect(popupLeft(500, 600, 320, 12)).toBe(280);
  });
});
