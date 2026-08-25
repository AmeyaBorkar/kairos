/**
 * FNV-1a, 32-bit.
 *
 * Chosen for being small, dependency-free and deterministic across every runtime this code will
 * ever meet — an experimental assignment has to be reproducible from the ledger months later, so a
 * hash that varies by platform or by V8 version would destroy the analysis it exists to support. It
 * is not a cryptographic hash and does not need to be: nobody gains anything by predicting which
 * arm they land in, and the test suite checks the only property that matters, which is that the
 * split is even.
 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // The FNV prime, 16777619, via Math.imul because the reference states this form and the
    // multiply must wrap at 32 bits rather than losing precision in a double.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const UINT32 = 4_294_967_296;

/**
 * A stable number in `[0, 1)` derived from a set of identifiers.
 *
 * Lives in `domain` rather than in whichever package first needed it because both arms of the
 * system run experiments and both must divide their populations the same way. Two copies of this
 * arithmetic that drifted apart would produce two subtly different answers to "was this treated?",
 * and the resulting comparison would be wrong in a way no test would catch.
 *
 * Parts are joined with a space, which none of the identifiers may contain, so `("a b", "c")` and
 * `("a", "b c")` are different draws rather than the same one.
 */
export function stableDraw(...parts: readonly string[]): number {
  return fnv1a(parts.join(" ")) / UINT32;
}

/**
 * Whether an identity falls in a holdout of the given size.
 *
 * A pure function of identifiers fixed before any outcome existed, which is what stops an analysis
 * from being retrofitted: nobody can choose the arms after seeing the results, because the arms
 * were never stored as a decision, only as a consequence of ids that were already fixed.
 */
export function inHoldout(fraction: number, ...parts: readonly string[]): boolean {
  if (fraction <= 0) return false;
  if (fraction >= 1) return true;
  return stableDraw(...parts) < fraction;
}
