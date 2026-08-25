/** 32-bit rotate left. JavaScript's shifts are signed, hence the unsigned coercion. */
function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * Seeded xoshiro128** — every random draw in the simulator comes from here.
 *
 * `Math.random` is banned throughout this package. A benchmark whose numbers change between runs
 * cannot support a claim, cannot gate a CI regression, and cannot be reproduced by anyone reading
 * the result. Given a seed, a run is byte-identical forever.
 */
export class Rng {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(seed: number) {
    // splitmix32 to spread a single integer seed across the full state — seeding xoshiro directly
    // from a small integer leaves it correlated for the first few hundred draws.
    let s = seed >>> 0;
    const mix = (): number => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.#a = mix();
    this.#b = mix();
    this.#c = mix();
    this.#d = mix();
  }

  /** Next raw 32-bit value. The xoshiro128** transition, verbatim. */
  #nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.#b, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.#b << 9) >>> 0;

    this.#c ^= this.#a;
    this.#d ^= this.#b;
    this.#b ^= this.#c;
    this.#a ^= this.#d;
    this.#c ^= t;
    this.#d = rotl(this.#d, 11);

    this.#a >>>= 0;
    this.#b >>>= 0;
    this.#c >>>= 0;
    this.#d >>>= 0;

    return result;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.#nextUint32() / 4294967296;
  }

  /** True with probability `p`. */
  bool(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Exponential with the given mean — inter-arrival times for a Poisson process. */
  exponential(mean: number): number {
    // 1 - next() so the argument is never 0 and the result never Infinity.
    return -Math.log(1 - this.next()) * mean;
  }

  /** Log-normal. Used for transaction amounts, which are heavily right-skewed in practice. */
  logNormal(mu: number, sigma: number): number {
    // Box-Muller. Only one of the pair is used; the cost is irrelevant here.
    const u1 = 1 - this.next();
    const u2 = this.next();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.exp(mu + sigma * normal);
  }

  /** Pick by relative weight. Weights need not sum to one. */
  pick<T>(items: readonly T[], weightOf: (item: T) => number): T {
    let total = 0;
    for (const item of items) total += weightOf(item);

    let roll = this.next() * total;
    for (const item of items) {
      roll -= weightOf(item);
      if (roll <= 0) return item;
    }
    // Floating-point drift only; the last item is the correct fallback.
    const last = items[items.length - 1];
    if (last === undefined) throw new Error("Rng.pick: empty list");
    return last;
  }

  /** Lower-case hex string of the requested length. */
  hex(length: number): string {
    let out = "";
    while (out.length < length) {
      out += this.#nextUint32().toString(16).padStart(8, "0");
    }
    return out.slice(0, length);
  }
}
