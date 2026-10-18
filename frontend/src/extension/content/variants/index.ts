/**
 * Registered GitHub markup variants. Adding a variant = add variants/<id>/ and list it here
 * (docs/internal/extension_dom_engine_design.md section 4.4); features never change.
 */
import type { VariantModule } from './types';
import { classic } from './classic';
import { react } from './react';

export const VARIANTS: readonly VariantModule[] = [classic, react];
