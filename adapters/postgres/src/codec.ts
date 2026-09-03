import {
  type ActionKind,
  attemptId,
  CASUALTY_KINDS,
  type Casualty,
  type CasualtyKind,
  casualtyId,
  customerRef,
  DomainError,
  type FailureDetail,
  isActionKind,
  isPaymentMethod,
  isRecoverabilityClass,
  orderId,
  paise,
  RECOVERY_OUTCOMES,
  type RecoveryAttempt,
  type RecoveryOutcome,
  type RetryCapability,
  slice,
} from "@kairos/domain";

/**
 * Turn a stored payload back into a casualty, or refuse it.
 *
 * A store is a trust boundary even when this process wrote the row. Between the write and the read
 * sit a schema migration, an older build of this service, a support engineer with `psql`, and a
 * restore from a backup taken mid-deploy — and a casualty that comes back subtly wrong does not
 * announce itself. It becomes a slice the detector cannot reason about, a `Paise` that is a float,
 * or a status the stopping rules read as "keep going".
 *
 * So every field goes back through the domain's own constructors rather than a cast. The cost is
 * this file; the benefit is that the only way a bad casualty enters the decision path is a bug in
 * the domain itself, which is the one place there are tests for it.
 */
export function parseCasualty(value: unknown): Casualty {
  const raw = typeof value === "string" ? text(value) : value;
  const c = object(raw, "casualty");
  const status = object(c["status"], "casualty.status");

  const recoverability = string(status["recoverability"], "casualty.status.recoverability");
  if (!isRecoverabilityClass(recoverability)) {
    throw new DomainError("casualty.status.recoverability", `unknown class ${recoverability}`);
  }

  const attemptRef = c["attemptId"];
  return {
    id: casualtyId(string(c["id"], "casualty.id")),
    kind: casualtyKind(string(c["kind"], "casualty.kind")),
    customer: customerRef(string(c["customer"], "casualty.customer")),
    orderId: orderId(string(c["orderId"], "casualty.orderId")),
    attemptId: attemptRef === null ? null : attemptId(string(attemptRef, "casualty.attemptId")),
    slice: parseSlice(c["slice"]),
    amount: paise(number(c["amount"], "casualty.amount"), "casualty.amount"),
    failure: parseFailure(c["failure"]),
    retry: retryCapability(string(c["retry"], "casualty.retry")),
    occurredAt: number(c["occurredAt"], "casualty.occurredAt"),
    status: {
      recovered: boolean(status["recovered"], "casualty.status.recovered"),
      optedOut: boolean(status["optedOut"], "casualty.status.optedOut"),
      disputed: boolean(status["disputed"], "casualty.status.disputed"),
      consecutiveHardDeclines: number(
        status["consecutiveHardDeclines"],
        "casualty.status.consecutiveHardDeclines",
      ),
      recoverability,
    },
    attempts: array(c["attempts"], "casualty.attempts").map(parseAttempt),
  };
}

/**
 * A payload that arrived as text rather than as a parsed document.
 *
 * `pg` parses jsonb, but a driver configured not to — or a column somebody migrated from `text` —
 * hands over a string. Wrapped so that every way a row can be wrong produces the same class of
 * error: a caller that catches `DomainError` around a read should not also have to catch
 * `SyntaxError` to cover the case where the corruption was worse.
 */
function text(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new DomainError("casualty", "payload is not JSON");
  }
}

function parseSlice(value: unknown): Casualty["slice"] {
  const s = object(value, "casualty.slice");
  const method = string(s["method"], "casualty.slice.method");
  if (!isPaymentMethod(method)) {
    throw new DomainError("casualty.slice.method", `unknown payment method ${method}`);
  }
  return slice(
    method,
    nullableString(s["issuer"], "casualty.slice.issuer"),
    nullableString(s["instrument"], "casualty.slice.instrument"),
  );
}

function parseFailure(value: unknown): FailureDetail | null {
  if (value === null || value === undefined) return null;
  const f = object(value, "casualty.failure");
  return {
    code: string(f["code"], "casualty.failure.code"),
    source: string(f["source"], "casualty.failure.source"),
    step: string(f["step"], "casualty.failure.step"),
    reason: string(f["reason"], "casualty.failure.reason"),
    description: string(f["description"], "casualty.failure.description"),
  };
}

function parseAttempt(value: unknown, i: number): RecoveryAttempt {
  const field = `casualty.attempts[${i}]`;
  const a = object(value, field);
  const kind = string(a["kind"], `${field}.kind`);
  if (!isActionKind(kind)) throw new DomainError(`${field}.kind`, `unknown action ${kind}`);
  const outcome = string(a["outcome"], `${field}.outcome`);
  if (!(RECOVERY_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new DomainError(`${field}.outcome`, `unknown outcome ${outcome}`);
  }
  const ref = a["externalRef"];
  return {
    kind: kind as ActionKind,
    at: number(a["at"], `${field}.at`),
    outcome: outcome as RecoveryOutcome,
    costPaise: paise(number(a["costPaise"], `${field}.costPaise`), `${field}.costPaise`),
    externalRef: ref === null || ref === undefined ? null : string(ref, `${field}.externalRef`),
  };
}

function casualtyKind(value: string): CasualtyKind {
  if (!(CASUALTY_KINDS as readonly string[]).includes(value)) {
    throw new DomainError("casualty.kind", `unknown kind ${value}`);
  }
  return value as CasualtyKind;
}

function retryCapability(value: string): RetryCapability {
  if (value !== "autonomous" && value !== "requires-customer") {
    throw new DomainError("casualty.retry", `unknown retry capability ${value}`);
  }
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError(field, `expected an object, received ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new DomainError(field, `expected an array, received ${describe(value)}`);
  }
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new DomainError(field, `expected a string, received ${describe(value)}`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : string(value, field);
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DomainError(field, `expected a finite number, received ${describe(value)}`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new DomainError(field, `expected a boolean, received ${describe(value)}`);
  }
  return value;
}

/** Names the shape without echoing the value, which may be a customer's. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
