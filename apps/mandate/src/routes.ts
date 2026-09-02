import type { Mandate } from "@kairos/domain";
import { sealMandate, verifyMandate } from "@kairos/terminus";
import { explainMandate } from "./explain.js";
import { type MandateSpec, toMandate } from "./spec.js";

export interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * Said in place of a signature while previewing.
 *
 * A preview has no signature and must not look as though it has one. The alternative — an empty
 * string — renders as a blank line under a heading that says SIGNATURE, which is the one thing this
 * whole tool exists to stop somebody skimming past.
 */
const UNSIGNED = "(preview — not signed)";

const NO_KEY =
  "This form is running without a signing key, so it can explain a mandate but cannot sign one. " +
  "Set KAIROS_MANDATE_SECRET and restart to seal from here, or save the spec and run " +
  "`kairos-mandate seal` on a machine that holds the key.";

/**
 * The form's two routes, as a pure function.
 *
 * Separated from the server so the interesting behaviour — what a bad spec does, what happens
 * without a key, whether the sealed mandate actually verifies — is testable without a socket.
 */
export function handle(route: "/preview" | "/seal", body: unknown, secret?: string): Reply {
  const spec = (body as { spec?: MandateSpec } | null)?.spec;
  if (spec === undefined || spec === null) {
    return {
      status: 400,
      body: { ok: false, error: 'expected a body of the form {"spec": {...}}' },
    };
  }

  let mandate: Mandate;
  try {
    mandate = { ...toMandate(spec), signature: UNSIGNED };
  } catch (error) {
    // A spec that cannot become a mandate is answered with the domain's own words. Those messages
    // name the field and say what was expected, which is exactly what a form needs to show.
    return {
      status: 400,
      body: { ok: false, error: error instanceof Error ? error.message : String(error) },
    };
  }

  if (route === "/preview") {
    return { status: 200, body: { ok: true, explanation: explainMandate(mandate) } };
  }

  if (secret === undefined) return { status: 403, body: { ok: false, error: NO_KEY } };

  const sealed = sealMandate({ ...mandate }, secret);
  return {
    status: 200,
    body: {
      ok: true,
      mandate: sealed,
      explanation: explainMandate(sealed, { secret, verify: verifyMandate }),
    },
  };
}
