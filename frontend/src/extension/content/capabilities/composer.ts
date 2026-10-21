/** composer capability: the new-comment composer's primary submit button and adjacent insertion point (section 6.3). */
import type { Resolver } from '../dom/resolver';
import type { VariantModule } from '../variants/types';
import type { ComposerCap } from './types';

export function createComposerCap(resolver: Resolver, module: VariantModule): ComposerCap {
  const root = (): Element | null => {
    const det = resolver.detection('composer');
    return det?.status === 'recognized' && det.root?.isConnected ? det.root : null;
  };

  // A collapsed composer (GitHub's compact one-line input, or an editor not rendered yet) has no
  // submit button by design. That's a legitimate state, not drift: don't resolve composer.submit,
  // so no expected-missing diagnostic is emitted until the composer expands.
  const collapsed = (): boolean => {
    const r = root();
    return Boolean(r && module.adapters.composer?.collapsed?.(r));
  };

  const submitButton = () => (collapsed() ? null : resolver.first('composer.submit'));

  return {
    collapsed,
    submitButton,
    insertionPoint: () => {
      const submit = submitButton();
      if (!submit) return null;
      return module.adapters.composer ? module.adapters.composer.insertionPoint(submit) : { before: submit };
    },
  };
}
