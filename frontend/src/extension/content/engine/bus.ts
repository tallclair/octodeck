/**
 * Typed, synchronous, per-session event bus (docs/internal/extension_dom_engine_design.md 5.4).
 *
 * The session owns one SessionBus; each feature mount gets a view bound to its AbortSignal so
 * its subscriptions disappear on unmount. Handler errors are isolated per handler.
 */
import type { BusEventName, BusEvents, EventBus } from './types';

type Handler = (value: unknown) => void;

export class SessionBus {
  private readonly handlers = new Map<BusEventName, Set<Handler>>();
  private readonly lastValues = new Map<BusEventName, unknown>();

  constructor(private readonly onHandlerError: (error: unknown, event: BusEventName) => void = () => {}) {}

  emit<K extends BusEventName>(name: K, value: BusEvents[K]): void {
    this.lastValues.set(name, value);
    for (const handler of Array.from(this.handlers.get(name) ?? [])) {
      try {
        handler(value);
      } catch (error) {
        this.onHandlerError(error, name);
      }
    }
  }

  last<K extends BusEventName>(name: K): BusEvents[K] | undefined {
    return this.lastValues.get(name) as BusEvents[K] | undefined;
  }

  /** A view whose subscriptions are removed when `signal` aborts and whose emits stop after it. */
  view(signal: AbortSignal, wrap: <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => void = (fn) => fn): EventBus {
    return {
      emit: (name, value) => {
        if (!signal.aborted) this.emit(name, value);
      },
      on: (name, cb) => {
        const set = this.handlers.get(name) ?? new Set<Handler>();
        this.handlers.set(name, set);
        const handler = wrap(cb as Handler);
        const off = () => {
          set.delete(handler);
        };
        if (signal.aborted) return off;
        set.add(handler);
        signal.addEventListener('abort', off, { once: true });
        return off;
      },
      last: (name) => this.last(name),
    };
  }

  clear(): void {
    this.handlers.clear();
    this.lastValues.clear();
  }
}
