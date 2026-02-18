import { useRef } from 'react';

/**
 * Returns a ref that always points to the latest value.
 * Synchronous assignment ensures the ref is current before
 * any effects or callbacks run in the same render cycle.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
