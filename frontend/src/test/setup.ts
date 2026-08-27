if (typeof (globalThis as unknown as { __IS_EXTENSION__?: boolean }).__IS_EXTENSION__ === 'undefined') {
  (globalThis as unknown as { __IS_EXTENSION__: boolean }).__IS_EXTENSION__ = true;
}
