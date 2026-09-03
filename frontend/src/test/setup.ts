if (typeof (globalThis as unknown as { __IS_EXTENSION__?: boolean }).__IS_EXTENSION__ === 'undefined') {
  (globalThis as unknown as { __IS_EXTENSION__: boolean }).__IS_EXTENSION__ = true;
}
if (typeof (globalThis as unknown as { __APP_VERSION__?: string }).__APP_VERSION__ === 'undefined') {
  (globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = 'v0.0.1-test';
}
