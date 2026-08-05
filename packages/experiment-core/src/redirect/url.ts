/**
 * `new URL()` with a placeholder base for relative inputs, returning null on
 * failure instead of throwing.
 *
 * The return type is INFERRED (never annotated `URL`) on purpose: experiment-core
 * is compiled under three different lib sets (browser DOM, Edge, Bun via
 * `@types/bun`), whose `URL` declarations differ. An explicit `: URL` annotation
 * picks one declaration and clashes with the others; letting the type flow from
 * `new URL()` keeps it consistent within each compilation.
 */

const PLACEHOLDER_BASE = 'https://placeholder.invalid';

export function safeUrl(input: string, base: string = PLACEHOLDER_BASE) {
  try {
    return new URL(input, base);
  } catch {
    return null;
  }
}

/** The (lib-dependent) URL instance type, derived without naming `URL`. */
export type SafeUrl = NonNullable<ReturnType<typeof safeUrl>>;
