/**
 * Engine-wide DOM markers. Every node OctoDeck creates carries OWN_ATTR; the CSS safe-mode valve
 * keys off SAFE_ATTR on <html>; INSTANCE_ATTR on <html> lets a newer content-script instance take
 * over from an orphaned one (docs/internal/extension_dom_engine_design.md section 5).
 */
export const OWN_ATTR = 'data-octodeck';
export const OWN_KEY_ATTR = 'data-octodeck-key';
export const SAFE_ATTR = 'data-octodeck-safe';
export const INSTANCE_ATTR = 'data-octodeck-instance';

/** Selector matching any OctoDeck-owned node. */
export const OWN_SELECTOR = `[${OWN_ATTR}]`;

/** Prefix every OctoDeck CSS class must use. */
export const OWN_CLASS_PREFIX = 'octodeck-gh-';

/** Returns true when the node is (inside) an OctoDeck-owned element. */
export function isOwnNode(node: Node | null | undefined): boolean {
  if (!node) return false;
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return Boolean(el?.closest(OWN_SELECTOR));
}
