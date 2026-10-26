// A tiny external store: the real-time code (WebSocket, decoders, input) writes to it, React reads
// slices of it with useStore. Components re-render only when their slice changes.
import { useRef, useSyncExternalStore } from 'react';

export type Store<T> = {
  get: () => T;
  set: (patch: Partial<T> | ((state: T) => Partial<T>)) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function shallowEqual(a: unknown, b: unknown) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a as object);
  if (ka.length !== Object.keys(b as object).length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** A slice of the store; a selector may build a new object or array, it's reused while its fields are the same. */
export function useStore<T extends object, S>(store: Store<T>, select: (state: T) => S): S {
  const last = useRef<{ value: S } | null>(null);
  return useSyncExternalStore(store.subscribe, () => {
    const value = select(store.get());
    if (last.current && shallowEqual(last.current.value, value)) return last.current.value;
    last.current = { value };
    return value;
  });
}

/** localStorage that survives private mode (reads fall back, writes are dropped). */
export const saved = {
  get(key: string, fallback = ''): string {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key: string, value: string) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  },
};

/** Same for sessionStorage (the room password, the admin token). */
export const session = {
  get(key: string): string {
    try { return sessionStorage.getItem(key) || ''; } catch { return ''; }
  },
  set(key: string, value: string) {
    try { sessionStorage.setItem(key, value); } catch { /* private mode */ }
  },
};
