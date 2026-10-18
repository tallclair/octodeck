/**
 * Small DOM builders for OctoDeck's own UI (WP4-internal). Everything built here lives inside an
 * own node created by the ledger, so it never carries GitHub classes and never uses innerHTML.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(className: string, opts: { label?: string; title?: string; disabled?: boolean } = {}): HTMLButtonElement {
  const b = h('button', className);
  b.type = 'button';
  if (opts.label) b.setAttribute('aria-label', opts.label);
  if (opts.title) b.title = opts.title;
  if (opts.disabled) {
    b.disabled = true;
    b.classList.add('octodeck-gh-disabled');
  }
  return b;
}

/** A 16x16-viewBox octicon-style icon from one path. */
export function svgIcon(
  pathD: string,
  size: number,
  attrs: { fill?: string; stroke?: string; strokeWidth?: string } = {}
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', attrs.fill ?? 'currentColor');
  if (attrs.stroke) svg.setAttribute('stroke', attrs.stroke);
  if (attrs.strokeWidth) svg.setAttribute('stroke-width', attrs.strokeWidth);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathD);
  svg.appendChild(path);
  return svg;
}

export const ICON_LINK_EXTERNAL =
  'M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.5 0a.75.75 0 0 1 .75-.75h3.25c.414 0 .75.336.75.75v3.25a.75.75 0 0 1-1.5 0V3.56l-4.22 4.22a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.44 2.5H11a.75.75 0 0 1-.75-.75Z';
export const ICON_STAR =
  'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z';
export const ICON_PENCIL =
  'M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm1.414 1.06a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354l-1.086-1.086ZM11.189 6.25 9.75 4.81 3.242 11.318a.25.25 0 0 0-.063.108l-.57 1.993 1.993-.57a.25.25 0 0 0 .108-.063L11.189 6.25Z';
export const ICON_PLUS =
  'M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z';
