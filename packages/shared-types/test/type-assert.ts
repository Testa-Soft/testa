/** Compile-time assertions (tsd-style). They are checked by `tsc --noEmit`, not at runtime. */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

export function assertType<T extends true>(_ok?: T): void {}

/** Accepts only values assignable to `T`. */
export function accepts<T>(_value: T): void {}
