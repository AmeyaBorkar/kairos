# Security

Kairos moves money and touches customer contact details. The controls below are design
requirements, not aspirations — where one is not yet implemented it is marked as such.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/AmeyaBorkar/kairos/security/advisories/new).
Please do not open a public issue for anything exploitable.

## Credentials

**Only test-mode credentials exist anywhere in this project.** There is no code path that expects a
live Razorpay key, and no environment in which one should be supplied.

Secrets are supplied through the environment and never committed. `.env.example` documents the shape
of every variable and contains no values. `gitleaks` scans the full history on every push, because a
credential that was committed and later removed has still leaked.

## Webhook verification

Razorpay signs webhooks with HMAC-SHA256 over the request body. Verification happens on the **raw
bytes, before JSON parsing** — parsing and re-serialising changes the bytes and breaks the signature,
and a handler that verifies the re-serialised form can be fed a body that parses to something other
than what was signed. Comparison is constant-time.

Event ids are de-duplicated and timestamps windowed, so a captured webhook cannot be replayed.

## Untrusted input reaching a language model

The reasoner reads text Kairos does not control: gateway error descriptions, catalog content, and
customer-supplied fields. Mitigations, in the order that matters:

1. **Model output is never executable.** There is no tool-call path from the reasoner to a money
   action. Its output is parsed into a closed schema and validated before anything acts on it.
2. **The action vocabulary is closed.** A proposal naming an action outside `ACTION_KINDS` is
   rejected before it reaches the kernel.
3. **Every money action clears Terminus** regardless of what proposed it.
4. Untrusted content is delimited and labelled as data in the prompt.

The worst outcome of a successful injection is a badly-worded message, not a payment.

## Personal data

The audit ledger stores **references, never raw personal data**. Phone numbers and email addresses
are keyed hashes; raw values live in one place with their own retention policy and access path. The
`CustomerRef` type enforces a minimum length that a hash always satisfies and a bare phone number
never does — a cheap structural guard against an identifier leaking into a logged field.

Prompts carry error codes and amounts, not names, except when composing customer-facing copy, which
receives a first name and nothing else.

## Bounded operation

Every outbound action clears Terminus admission, which enforces the campaign budget, per-customer
contact caps, quiet hours, global blast radius, and the hard stopping rules. A single kill switch in
the shared store halts all outbound money actions fleet-wide within one admission check.

Where the store is unavailable, spending degrades to a *tighter* bound and then halts. Steering
degrades to the merchant's default method order. The direction differs because the least-action
outcome differs: not spending is safe, but not showing a checkout is not.

## No unaudited money movement

If the ledger cannot be written, outbound actions stop. An action that cannot be accounted for is
worse than an action not taken.

## Supply chain

Dependencies are pinned by lockfile and installed with `--frozen-lockfile`. Production dependencies
are audited on every push at `moderate` and above; development advisories are reported without
blocking. Dependabot proposes updates weekly. CodeQL runs `security-and-quality` on every push and
weekly on a schedule.
