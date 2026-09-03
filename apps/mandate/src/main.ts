import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { Mandate } from "@kairos/domain";
import { migrate } from "@kairos/postgres";
import { sealMandate, verifyMandate } from "@kairos/terminus";
import { Pool } from "pg";
import { PostgresStore } from "throttlekit/postgres";
import { explainMandate } from "./explain.js";
import { handle } from "./routes.js";
import { type MandateSpec, toMandate } from "./spec.js";
import { engage, release, type StopTarget, status } from "./stop.js";

/**
 * The mandate authoring path.
 *
 * Before this, a mandate was constructed in code and sealed at a call site — which is fine for a
 * worker booting itself and impossible for a merchant, who has to be able to say what they are
 * authorising, see what it means, sign it, and hand the result to an operator.
 *
 * ## Why the form and the signature are separate programs
 *
 * The signing key is the whole security model: anyone holding it can mint a mandate with any budget
 * and any kill switch, and the kernel will honour it. So the key never goes anywhere it does not
 * have to. The form is a page that collects a *spec* — rupees, days, clock times — and the spec is
 * worthless on its own, because the kernel rejects an unsigned mandate. Sealing happens in this
 * process, from `KAIROS_MANDATE_SECRET`, on a machine the operator chose.
 *
 * `form` serves that page and does the conversion server-side, which is not a security decision but
 * a correctness one: there is exactly one implementation of "₹5,000 for 30 days" and the page calls
 * it rather than re-deriving it. A form that did its own arithmetic would be a second place to
 * write ₹5,000 as five thousand paise.
 *
 * ## Usage
 *
 * ```
 * kairos-mandate form [--port 8181]     # author one in a browser, on localhost
 * kairos-mandate seal   [spec.json]     # spec in, signed mandate out (needs the secret)
 * kairos-mandate explain [mandate.json] # what a signed mandate actually authorises
 * kairos-mandate verify  [mandate.json] # exit 0 if the signature is ours (needs the secret)
 *
 * kairos-mandate status                 # is this campaign stopped? (needs the database)
 * kairos-mandate stop "<reason>"        # stop it, fleet-wide, without re-signing anything
 * kairos-mandate resume                 # let it run again
 * ```
 *
 * ## Why the stop lives here
 *
 * A mandate is authority granted; the stop is authority withdrawn in a hurry. Somebody who needs
 * the second at three in the morning should not have to remember that it lives in a different
 * program. It needs the database and *not* the signing key, which is the opposite of every other
 * command in this file and is the point: stopping a campaign must not require the ability to mint
 * one, because the person on call is not necessarily the person who holds the key.
 */
const USAGE = `kairos-mandate — author, sign, and read a mandate

  form [--port N]        Serve the authoring form on 127.0.0.1. Seals only if the secret is set.
  seal [spec.json]       Read a spec (file, or stdin), print the signed mandate to stdout.
                         The plain-English reading goes to stderr, so you see what you signed
                         even when redirecting stdout to a file.
  explain [mandate.json] Print what a signed mandate authorises, in words.
  verify [mandate.json]  Exit 0 if the signature is this secret's, 1 if it is not.

  status                 Whether this campaign has been stopped, and by whom.
  stop "<reason>"        Stop it. Fleet-wide, on each worker's next admission.
  resume                 Let it run again, under the mandate that was always in force.

KAIROS_MANDATE_SECRET must be at least 32 characters. There is no development default:
a mandate signed with a publicly-known key is a mandate anyone can forge.

status, stop and resume need KAIROS_DATABASE_URL and not the secret. That is deliberate:
stopping a campaign must not require the ability to mint one, because the person on call
is not necessarily the person who holds the key.
KAIROS_MERCHANT_ID and KAIROS_CAMPAIGN_ID name the campaign; the campaign defaults to
"recovery", which is what the worker uses unless it was told otherwise.
`;

function secretOrExit(): string {
  const secret = process.env["KAIROS_MANDATE_SECRET"];
  if (secret === undefined || secret.length < 32) {
    process.stderr.write(
      "KAIROS_MANDATE_SECRET must be set to at least 32 characters. Refusing to continue.\n",
    );
    process.exit(2);
  }
  return secret;
}

/** A file if one was named, otherwise stdin. Both are how a person would expect this to work. */
function read(path: string | undefined): unknown {
  const text = readFileSync(path ?? 0, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    process.stderr.write(`Not JSON: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

function fail(error: unknown): never {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

function seal(path: string | undefined): void {
  const secret = secretOrExit();
  let mandate: Mandate;
  try {
    mandate = sealMandate(toMandate(read(path) as MandateSpec), secret);
  } catch (error) {
    fail(error);
  }

  // The reading goes to stderr and the mandate to stdout, so `kairos-mandate seal spec.json >
  // mandate.json` still shows the operator what they just authorised. Signing something you did
  // not read is the failure this tool exists to prevent.
  process.stderr.write(
    `${explainMandate(mandate, { secret, verify: verifyMandate }).join("\n")}\n\n`,
  );
  process.stdout.write(`${JSON.stringify(mandate, null, 2)}\n`);
}

function explain(path: string | undefined): void {
  const mandate = read(path) as Mandate;
  const secret = process.env["KAIROS_MANDATE_SECRET"];
  try {
    const options = secret === undefined ? {} : { secret, verify: verifyMandate };
    process.stdout.write(`${explainMandate(mandate, options).join("\n")}\n`);
  } catch (error) {
    fail(error);
  }
}

function verify(path: string | undefined): void {
  const secret = secretOrExit();
  const mandate = read(path) as Mandate;
  const ok = verifyMandate(mandate, secret);
  process.stdout.write(ok ? "verified\n" : "SIGNATURE DOES NOT VERIFY\n");
  process.exit(ok ? 0 : 1);
}

/** A spec is a few hundred bytes; this is three orders of magnitude of headroom. */
const MAX_BODY_BYTES = 64_000;

/**
 * Whether this request came from the page this process is serving.
 *
 * A missing `Origin` is a non-browser client — `curl`, a script, a test — and is allowed, because
 * refusing it would break every use of these routes that does not involve a browser without making
 * a browser any safer. What is refused is an `Origin` that is present and belongs to somebody else.
 */
function sameOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function reply(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, {
    "content-type": "application/json",
    // Nothing here should be cached, framed, or sniffed into another type: one of these responses
    // is a signed mandate.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function form(argv: readonly string[]): void {
  const portIndex = argv.indexOf("--port");
  const port = portIndex === -1 ? 8181 : Number(argv[portIndex + 1]);
  if (!Number.isSafeInteger(port) || port <= 0) fail(new Error("--port expects a port number"));

  // Optional here, unlike everywhere else. An operator without the key can still author and read a
  // spec; they simply cannot sign it, and the form says so rather than pretending.
  const secret = process.env["KAIROS_MANDATE_SECRET"];
  const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

  const server = createServer((request, response) => {
    const url = request.url ?? "/";

    if (request.method === "GET" && (url === "/" || url.startsWith("/?"))) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(page);
      return;
    }

    if (request.method === "POST" && (url === "/preview" || url === "/seal")) {
      // A page on any other origin can make this request; what it cannot do is read the answer,
      // because nothing here sends CORS headers. That is already enough, since neither route has a
      // side effect worth triggering blind — but a route that mints signed spending authority
      // should not rest its safety on a header it forgot to send, so the origin is checked. Absent
      // is allowed: `curl` and every other non-browser client sends none.
      if (!sameOrigin(request.headers.origin, port)) {
        reply(response, 403, { ok: false, error: "cross-origin request refused" });
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      request.on("data", (chunk: Buffer) => {
        if (aborted) return;
        size += chunk.length;
        // A form spec is a few hundred bytes. Anything larger is not one. Answered rather than
        // dropped: destroying the socket leaves the caller waiting on a response that never comes.
        if (size > MAX_BODY_BYTES) {
          aborted = true;
          reply(response, 413, { ok: false, error: "body too large for a mandate spec" });
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (aborted) return;
        let answer: ReturnType<typeof handle>;
        try {
          answer = handle(
            url,
            JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
            secret,
          );
        } catch {
          answer = { status: 400, body: { ok: false, error: "not JSON" } };
        }
        reply(response, answer.status, answer.body);
      });
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found\n");
  });

  // Loopback only, and not configurable. This process may hold a signing key; a form that binds
  // 0.0.0.0 is a key-minting endpoint on the network, and an operator who genuinely wants that
  // should have to build it deliberately rather than pass a flag.
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`kairos-mandate form  http://127.0.0.1:${port}\n`);
    process.stdout.write(
      secret === undefined
        ? "  No signing key. It will explain a mandate but refuse to seal one.\n"
        : "  Signing key loaded. Sealing from this page is enabled.\n",
    );
  });
}

/**
 * Open the store the fleet shares, run one command against it, and close it.
 *
 * A connection per invocation, because this is a command somebody types and not a service. The pool
 * is closed in a `finally` so a failed read still exits rather than hanging on an open socket — an
 * operator running `stop` and getting no prompt back would reasonably assume it had not worked and
 * run it again.
 */
async function stopCommand(command: string, rest: readonly string[]): Promise<void> {
  const url = process.env["KAIROS_DATABASE_URL"];
  if (url === undefined) {
    process.stderr.write(
      "KAIROS_DATABASE_URL must be set. The stop lives in the store the fleet shares, because a\n" +
        "switch held in one process could only stop that process — and an operator who ran one\n" +
        "command expecting everything to halt would believe it had.\n",
    );
    process.exit(2);
  }

  const target: StopTarget = {
    merchantId: process.env["KAIROS_MERCHANT_ID"] ?? "",
    campaignId: process.env["KAIROS_CAMPAIGN_ID"] ?? "recovery",
  };
  if (target.merchantId === "") {
    process.stderr.write("KAIROS_MERCHANT_ID must be set: a stop has to be aimed at a campaign.\n");
    process.exit(2);
  }

  if (command === "stop" && (rest[0] === undefined || rest[0].trim() === "")) {
    process.stderr.write(
      'A reason is required: kairos-mandate stop "customers are being messaged twice"\n' +
        "Whoever finds this stopped campaign next will want to know why, and the first reason\n" +
        "recorded is the one that is kept.\n",
    );
    process.exit(2);
  }

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    if (process.env["KAIROS_DB_MIGRATE"] !== "off") await migrate(pool);
    const store = new PostgresStore({ pool, table: "kairos_throttle" });
    const now = Date.now();
    try {
      const lines =
        command === "status"
          ? await status(store, target, now)
          : command === "resume"
            ? await release(store, target, now)
            : await engage(
                store,
                target,
                now,
                rest[0] as string,
                // Who, as well as they can be identified without asking. An unrecorded "by" is
                // better than a fabricated one, so this falls back rather than inventing.
                process.env["KAIROS_OPERATOR"] ??
                  process.env["USER"] ??
                  process.env["USERNAME"] ??
                  "unrecorded",
              );
      process.stdout.write(`${lines.join("\n")}\n`);
    } finally {
      await store.close();
    }
  } catch (error) {
    fail(error);
  } finally {
    await pool.end();
  }
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "form":
    form(rest);
    break;
  case "seal":
    seal(rest[0]);
    break;
  case "explain":
    explain(rest[0]);
    break;
  case "verify":
    verify(rest[0]);
    break;
  case "status":
  case "stop":
  case "resume":
    await stopCommand(command, rest);
    break;
  default:
    process.stdout.write(USAGE);
    process.exit(command === undefined || command === "--help" || command === "-h" ? 0 : 2);
}
