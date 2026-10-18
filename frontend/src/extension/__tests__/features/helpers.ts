/**
 * Shared helpers for WP4 feature tests (fake capabilities only; no GitHub selectors).
 */
import { vi } from 'vitest';
import type { Item } from '../../../api/octodeck/v1/resources_pb';
import type { ExtensionMessage, ExtensionResponse } from '../../types';
import { createFakeCapabilities, createFakePage } from '../fakes/capabilities';
import type { Capabilities } from '../../content/capabilities/types';
import type { PageFacts } from '../../content/dom/types';

export const REF = { owner: 'octo', repo: 'deck', number: 1, itemId: 'octo/deck#1', nodeId: 'I_node1' };

export function makeItem(overrides: Record<string, unknown> = {}, local: Record<string, unknown> = {}): Item {
  return {
    id: 'I_node1',
    repo: 'octo/deck',
    number: 1,
    viewerSubscription: 1,
    local: { starred: false, privateNotes: '', ...local },
    ...overrides,
  } as unknown as Item;
}

export function capsWith(overrides: Partial<Capabilities> = {}, facts: Partial<PageFacts> = {}): Capabilities {
  return createFakeCapabilities({ page: createFakePage({ item: REF, ...facts }), ...overrides });
}

/** A scripted background: maps message type to a responder. */
export function backend(handlers: Partial<Record<ExtensionMessage['type'], (msg: ExtensionMessage) => ExtensionResponse>>) {
  return vi.fn((msg: ExtensionMessage): ExtensionResponse => {
    const h = handlers[msg.type];
    return h ? h(msg) : { ok: false, error: 'unhandled' };
  });
}

/** Lets pending promise callbacks (fake ctx.send) run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}
