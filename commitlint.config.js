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
        "ports",
        "razorpay",
        "simulator",
        "reasoner",
        "store",
        "messenger",
        "sentry",
        "worker",
        "checkout",
        "console",
        "bench",
        "build",
        "ci",
        "deps",
        "docs",
        "security",
      ],
    ],
    "body-max-line-length": [1, "always", 100],
  },
};
