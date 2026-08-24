export function getTowerKey(): string | undefined {
  const g = globalThis as typeof globalThis & { __CODEV_TOWER_KEY__?: unknown };
  const key = g.__CODEV_TOWER_KEY__;
  return typeof key === 'string' && key !== '' ? key : undefined;
}
