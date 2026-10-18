/** composer capability: the new-comment composer's primary submit button and adjacent insertion point (section 6.3). */
import type { Resolver } from '../dom/resolver';
import type { VariantModule } from '../variants/types';
import type { ComposerCap } from './types';

export function createComposerCap(resolver: Resolver, module: VariantModule): ComposerCap {
  const submitButton = () => resolver.first('composer.submit');
  return {
    submitButton,
    insertionPoint: () => {
      const submit = submitButton();
      if (!submit) return null;
      return module.adapters.composer ? module.adapters.composer.insertionPoint(submit) : { before: submit };
    },
  };
}
