import React from 'react';
import {
  matchWildcard,
  parseFilterPatterns,
  serializeFilterPatterns,
  validateBasePattern,
  validatePatterns,
  validateFilterPatterns,
  filterByPatterns,
  type ParsedFilterPatterns,
} from './patterns';

export {
  matchWildcard,
  parseFilterPatterns,
  serializeFilterPatterns,
  type ParsedFilterPatterns,
};

/**
 * Generates badge CSS properties based on a GitHub hex color string (e.g. "d73a4a" or "#ededed").
 * Calculates perceived luminance to ensure high-contrast text and clean borders on both light and dark themes.
 */
export function getLabelStyle(color?: string): React.CSSProperties {
  if (!color) {
    return {
      backgroundColor: '#64748b',
      color: '#ffffff',
      borderColor: 'rgba(0, 0, 0, 0.15)',
    };
  }
  const hex = color.replace(/^#/, '');
  if (hex.length !== 6 && hex.length !== 3) {
    return {
      backgroundColor: '#64748b',
      color: '#ffffff',
      borderColor: 'rgba(0, 0, 0, 0.15)',
    };
  }
  const r = parseInt(hex.length === 3 ? hex[0] + hex[0] : hex.slice(0, 2), 16);
  const g = parseInt(hex.length === 3 ? hex[1] + hex[1] : hex.slice(2, 4), 16);
  const b = parseInt(hex.length === 3 ? hex[2] + hex[2] : hex.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) {
    return {
      backgroundColor: '#64748b',
      color: '#ffffff',
      borderColor: 'rgba(0, 0, 0, 0.15)',
    };
  }

  const fullHex = hex.length === 3
    ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
    : hex;

  // Calculate perceived brightness using standard ITU-R BT.601 formula
  const luminance = (r * 299 + g * 587 + b * 114) / 1000;
  const isLight = luminance >= 140; // ~0.55 * 255 = 140.25

  return {
    backgroundColor: `#${fullHex}`,
    color: isLight ? '#0f172a' : '#ffffff',
    borderColor: isLight ? 'rgba(0, 0, 0, 0.18)' : 'rgba(255, 255, 255, 0.18)',
  };
}

/**
 * Validates a single label pattern. Returns an error message if invalid, or null if valid.
 */
export function validateLabelPattern(pattern: string): string | null {
  const baseResult = validateBasePattern(pattern, 'Label');
  if (baseResult.error) {
    return baseResult.error;
  }
  return null;
}

/**
 * Validates a list of label patterns. Returns the first error message, or null if valid.
 */
export function validateLabelPatterns(patterns: string[]): string | null {
  return validatePatterns(patterns, validateLabelPattern);
}

/**
 * Validates a multi-line label filter string. Returns the first error message, or null if valid.
 */
export function validateLabelFilterPatterns(patternsText: string): string | null {
  return validateFilterPatterns(patternsText, validateLabelPattern);
}

/**
 * Filters a list of labels based on included and excluded wildcard patterns.
 * If includedPatterns is non-empty, labels must match at least one include pattern.
 * If excludedPatterns is non-empty, labels matching any exclude pattern are removed.
 * Exclude patterns take precedence over include patterns.
 */
export function filterLabels<T extends { name?: string }>(
  labels: T[],
  includedPatterns?: string[],
  excludedPatterns?: string[]
): T[] {
  return filterByPatterns(labels, label => label.name, includedPatterns, excludedPatterns);
}
