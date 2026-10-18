/**
 * Content-side messaging to the background (docs/internal/extension_dom_engine_design.md 5.7).
 *
 * One helper for every content-script message: never throws, maps lastError to {ok:false},
 * detects an invalidated extension context (orphaned content script), and never settles once the
 * caller's signal has aborted.
 */
import type { ExtensionMessage, ExtensionResponse } from '../../types';

/** True when this content script's extension context is gone (extension reloaded or updated). */
export function isContextInvalidated(): boolean {
  try {
    return typeof chrome === 'undefined' || !chrome.runtime?.id;
  } catch {
    return true;
  }
}

function isInvalidationError(message: string | undefined): boolean {
  return Boolean(message && /context invalidated/i.test(message));
}

export interface Messenger {
  send<T = unknown>(msg: ExtensionMessage, signal?: AbortSignal): Promise<ExtensionResponse<T>>;
}

/**
 * @param onInvalidated called once when the extension context is found to be invalidated.
 */
export function createMessenger(onInvalidated: () => void): Messenger {
  let invalidated = false;
  const markInvalidated = () => {
    if (invalidated) return;
    invalidated = true;
    onInvalidated();
  };

  return {
    send<T>(msg: ExtensionMessage, signal?: AbortSignal): Promise<ExtensionResponse<T>> {
      if (signal?.aborted) return new Promise(() => {});
      if (invalidated || isContextInvalidated()) {
        markInvalidated();
        return Promise.resolve({ ok: false, error: 'Extension context invalidated' });
      }
      return new Promise<ExtensionResponse<T>>((resolve) => {
        const settle = (res: ExtensionResponse<T>) => {
          // Late responses after abort are dropped: the promise never settles.
          if (!signal?.aborted) resolve(res);
        };
        try {
          chrome.runtime.sendMessage(msg, (response: ExtensionResponse<T> | undefined) => {
            const lastError = chrome.runtime.lastError?.message;
            if (lastError) {
              if (isInvalidationError(lastError)) markInvalidated();
              settle({ ok: false, error: lastError });
              return;
            }
            settle(response ?? { ok: false, error: 'No response from background' });
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isInvalidationError(message)) markInvalidated();
          settle({ ok: false, error: message });
        }
      });
    },
  };
}
