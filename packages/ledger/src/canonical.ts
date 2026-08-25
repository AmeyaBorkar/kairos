/** JSON values the ledger will serialise. Deliberately narrow. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export class CanonicalizationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path || "<root>"}: ${message}`);
    this.name = "CanonicalizationError";
    this.path = path;
  }
}

/**
 * Deterministic JSON serialisation: object keys sorted, no incidental whitespace, and every
 * ambiguous value rejected rather than coerced.
 *
 * A hash chain is only tamper-evident if the same record always produces the same bytes.
 * `JSON.stringify` does not guarantee that — key order follows insertion order, so two records
 * built by different code paths with identical content hash differently, and the chain fails
 * verification for a record nobody touched.
 *
 * Rejections are as important as the sorting:
 * - `undefined` would be silently dropped, so a record could lose a field without changing its hash.
 * - `NaN` and `Infinity` serialise to `null`, so three different values would share one hash.
 * - Non-integer keys are fine, but symbols and functions are not representable at all.
 */
export function canonicalize(value: JsonValue, path = ""): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(path, `non-finite number ${value} is not representable`);
      }
      // Normalise -0 to 0; they are indistinguishable in JSON but not in JavaScript.
      return JSON.stringify(value === 0 ? 0 : value);

    case "string":
      return JSON.stringify(value);

    case "object": {
      if (Array.isArray(value)) {
        const items = value.map((item, i) => canonicalize(item, `${path}[${i}]`));
        return `[${items.join(",")}]`;
      }

      const record = value as { [key: string]: JsonValue };
      const keys = Object.keys(record).sort();
      const entries = keys.map((key) => {
        const child = record[key];
        const childPath = path ? `${path}.${key}` : key;
        if (child === undefined) {
          throw new CanonicalizationError(childPath, "undefined is not representable");
        }
        return `${JSON.stringify(key)}:${canonicalize(child, childPath)}`;
      });
      return `{${entries.join(",")}}`;
    }

    default:
      throw new CanonicalizationError(path, `${typeof value} is not representable`);
  }
}
