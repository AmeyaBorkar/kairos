#!/usr/bin/env node

/**
 * The first time this client touches Razorpay.
 *
 * Everything in `client.ts` — authentication, the retry policy, the deadline, the error mapping —
 * is written against Razorpay's published API and tested against a stubbed transport. CI holds no
 * credentials and never will, so the stub is all CI can offer, and a stub can be confidently wrong
 * about every one of those. This closes that gap on demand, and writes `docs/razorpay-probe.json`
 * as the evidence.
 *
 * It cannot exercise the retry policy, and no probe can: 429 and 5xx are what drive it, and a
 * healthy gateway will not produce either on request. What this proves is the part a stub can
 * always be wrong about — that the credentials authenticate, that the JSON we send is the JSON
 * Razorpay expects, that the entity comes back in the shape we parse, and that a 4xx becomes a
 * non-retryable error rather than a spin.
 *
 *   pnpm razorpay:probe          # create an order, read it back, exercise the error path
 *   pnpm razorpay:probe --link   # also create a payment link you can actually pay
 *
 * ## What it will and will not do
 *
 * It creates an **order**, which is a request for money that nobody has paid — no charge, no
 * customer contact, nothing that costs anything or reaches anyone. With `--link` it also creates a
 * payment link, which is a URL: still nothing until somebody opens it.
 *
 * It refuses to run against a live key. Everything in this project is test mode by policy, and the
 * failure mode of getting that wrong is a real charge to a real person.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RazorpayClient, RazorpayError } from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

/** The dotenv parser this needs is four lines, and a dependency for four lines is a dependency. */
function env() {
  const path = join(ROOT, ".env");
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match !== null) out[match[1]] = match[2].trim();
  }
  return out;
}

const config = { ...env(), ...process.env };
const keyId = config.RAZORPAY_KEY_ID ?? "";
const keySecret = config.RAZORPAY_KEY_SECRET ?? "";

if (keyId === "" || keySecret === "") {
  process.stderr.write(
    "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set, in .env or the environment.\n" +
      "Razorpay Dashboard -> test mode -> Settings -> API Keys -> Generate Test Key.\n",
  );
  process.exit(2);
}
if (!keyId.startsWith("rzp_test_")) {
  process.stderr.write(
    `Refusing to run: ${keyId.slice(0, 9)}… is not a test key.\n` +
      "This creates real orders against whatever account it is pointed at. Test mode only.\n",
  );
  process.exit(2);
}

/**
 * The transport, wired to the real network.
 *
 * `fetch` itself, which is what `client.ts` says the production wiring is — so this probe exercises
 * the same path a deployment would rather than a special one built to succeed. Every call is
 * recorded on the way past, because the point of the run is the transcript.
 */
const calls = [];
const transport = async (url, init) => {
  const startedAt = Date.now();
  const response = await fetch(url, init);
  const text = await response.text();
  calls.push({
    method: init.method,
    // The path only. The base URL is constant and the query, if there ever is one, is not ours.
    path: new URL(url).pathname,
    status: response.status,
    ms: Date.now() - startedAt,
    requestId: response.headers.get("x-razorpay-request-id"),
  });
  return { status: response.status, headers: response.headers, text: () => Promise.resolve(text) };
};

const client = new RazorpayClient({ credentials: { keyId, keySecret }, transport });

const stamp = new Date().toISOString();
const receipt = `kairos_probe_${Date.now().toString(36)}`;
const steps = [];

const record = (name, detail) => {
  steps.push({ name, ...detail });
  process.stdout.write(`${JSON.stringify({ step: name, ...detail })}\n`);
};

async function attempt(name, run) {
  try {
    record(name, { ok: true, ...(await run()) });
    return true;
  } catch (error) {
    if (error instanceof RazorpayError) {
      record(name, {
        ok: false,
        status: error.status,
        code: error.code,
        retryable: error.retryable,
        requestId: error.requestId,
        detail: error.message,
      });
      return false;
    }
    record(name, { ok: false, detail: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

process.stdout.write(`${JSON.stringify({ probe: "razorpay", mode: "test", keyId, at: stamp })}\n`);

// 1 · An order. The smallest real thing this API does, and the one every checkout starts with.
let orderId = null;
await attempt("create order", async () => {
  const order = await client.createOrder({
    amountPaise: 100,
    currency: "INR",
    receipt,
    notes: { source: "kairos-probe" },
  });
  orderId = order.id;
  return { id: order.id, amount: order.amount, currency: order.currency, status: order.status };
});

// 2 · The error path, against a payment id that cannot exist. A client whose happy path works and
//     whose failure path has never been seen is a client with an untested half.
await attempt("fetch a payment that does not exist", async () => {
  await client.fetchPayment("pay_KairosProbeNoSuch");
  return { unexpected: "the gateway returned an entity for an id that should not exist" };
});

// 3 · A payment link, only when asked for. It is a URL somebody could actually pay, and creating
//     one by default would leave a trail of them in the dashboard after a few probe runs.
if (process.argv.includes("--link")) {
  await attempt("create payment link", async () => {
    const link = await client.createPaymentLink({
      amountPaise: 100,
      currency: "INR",
      referenceId: `${receipt}_link`,
      description: "Kairos probe — test mode, one rupee",
      notes: { source: "kairos-probe" },
    });
    return { id: link.id, status: link.status, url: link.short_url };
  });
}

const errorPathBehaved = steps.some(
  (s) => s.name === "fetch a payment that does not exist" && s.ok === false && s.status === 400,
);

const summary = {
  at: stamp,
  keyId,
  liveCalls: calls.length,
  orderCreated: orderId,
  errorPathBehaved,
  // The whole claim this probe supports, stated so it cannot be overread.
  verified:
    orderId !== null && errorPathBehaved
      ? "authentication, request shaping, entity parsing and 4xx error mapping, against the live test API"
      : "incomplete — see the steps above",
};
process.stdout.write(`${JSON.stringify(summary)}\n`);

const out = join(ROOT, "docs", "razorpay-probe.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  // No credentials, no headers, no response bodies — the ids are the merchant's own references and
  // the timings are the interesting part. A transcript worth committing is one nobody has to redact.
  `${JSON.stringify({ ...summary, calls, steps }, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify({ transcript: "docs/razorpay-probe.json" })}\n`);

process.exitCode = orderId !== null && errorPathBehaved ? 0 : 1;
