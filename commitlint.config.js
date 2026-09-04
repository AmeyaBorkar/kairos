/**
 * Conventional commits. History on this repository must stay bisectable:
 * every commit builds and passes CI on its own.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        "domain",
        "detect",
        "policy",
        "recover",
        "terminus",
        "ledger",
        "proof",
        "ports",
        "razorpay",
        "simulator",
        "reasoner",
        "store",
        "postgres",
        "messenger",
        "sentry",
        "mandate",
        "worker",
        "checkout",
        "console",
        "site",
        "bench",
        "build",
        "ci",
        "deps",
        "docs",
        "security",
        // Dependabot emits this one: .github/dependabot.yml sets
        // prefix-development to chore(deps-dev), and this list did not know.
        "deps-dev",
      ],
    ],
    "body-max-line-length": [1, "always", 100],
  },

  /*
   * Dependabot writes its own subject and nothing in this repository can change it.
   *
   *   chore(deps-dev): bump X from 1.2.3 to 1.2.4 in the dev-dependencies group across 1 directory
   *
   * That is 107 characters before the package name is even long, so it fails
   * header-max-length on its own — which meant every dependency pull request this
   * repository opened was red on a rule nobody could satisfy. A check that is
   * permanently red teaches the one thing a check must never teach: that red is
   * normal. The pattern is narrow on purpose; a human writing a deps commit by
   * hand is still held to the same limit as every other commit.
   */
  ignores: [(message) => /^chore\(deps(?:-dev)?\): bump .+ from \S+ to \S+/.test(message)],
};
