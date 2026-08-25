declare const __brand: unique symbol;

/**
 * A nominal type. `Brand<string, "CasualtyId">` is assignable to `string`, but a bare `string`
 * is not assignable to it — so an id can never be passed where a different id is expected, and
 * a raw number can never be passed where money is expected.
 */
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Thrown when a value fails a domain invariant. Never caught to recover — it means a bug. */
export class DomainError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "DomainError";
    this.field = field;
  }
}
