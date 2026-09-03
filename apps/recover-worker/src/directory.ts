import { createHash } from "node:crypto";
import type { CustomerRef } from "@kairos/domain";
import type { CustomerDirectory, CustomerProfile } from "@kairos/recover";
import { languageOf } from "@kairos/simulator";

/**
 * A directory with nobody real in it.
 *
 * The worker's default directory returns `null` for everyone, which is the right behaviour for a
 * process that has not been given access to customer data: no name, no language, no token, so every
 * retry is impossible and every message is addressed to no one. Correct, and completely opaque —
 * because the executor short-circuits before it composes anything, and the two things most worth
 * seeing in a dry run are the words Kairos would have sent and what sending them would have cost.
 *
 * So this stands in. Every field is derived from the customer reference by hash, which gives three
 * properties that matter more than realism: the same reference always resolves to the same person,
 * a fleet of workers agree without sharing anything, and nothing has to be stored.
 *
 * ## What it is not
 *
 * It is not a fixture of invented people, and it holds no contact details at all — there is no
 * phone number or email here, because the messenger in this mode never dials one. What it supplies
 * is exactly the three facts the decision path reads: whether the payment can be charged again,
 * what language the customer reads, and a first name to address them by. A deployment replaces this
 * with a lookup against the merchant's own records, and that lookup is the only place in Kairos
 * where personal data is resolved.
 */
export interface SimulatedDirectoryOptions {
  /**
   * Share of customers whose payments carry a token or mandate.
   *
   * The single number that decides how much of the recovery arm exists. Everyone else has to be
   * present for a payment to go through, and asking them to be present is a message.
   */
  readonly mandatedShare: number;
}

/** Names, not people. Enough to show that composed copy addresses somebody by name. */
const NAMES = [
  "Aarav",
  "Diya",
  "Vihaan",
  "Ananya",
  "Arjun",
  "Ishaan",
  "Kavya",
  "Rohan",
  "Meera",
  "Aditya",
  "Sara",
  "Kabir",
] as const;

/** A stable number in [0, 1) for one customer and one purpose. */
function draw(purpose: string, customer: string): number {
  const digest = createHash("sha256").update(`${purpose}:${customer}`).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

export function simulatedDirectory(options: SimulatedDirectoryOptions): CustomerDirectory {
  return {
    lookup(customer: CustomerRef): Promise<CustomerProfile | null> {
      const mandated = draw("token", customer) < options.mandatedShare;
      return Promise.resolve({
        firstName: NAMES[Math.floor(draw("name", customer) * NAMES.length)] ?? null,
        // The simulator's own derivation, not a second one that happens to agree today. A customer
        // reads the same language here as they do in every arm of every benchmark run, which is the
        // only way the copy library's measured coverage means anything about this stack.
        language: languageOf(customer),
        // Shaped like a Razorpay token so nothing downstream special-cases it, and useless to
        // anything: it can only be charged against a gateway that does not exist in this mode.
        token: mandated ? `token_sim_${draw("id", customer).toString(36).slice(2, 16)}` : null,
      });
    },
  };
}
