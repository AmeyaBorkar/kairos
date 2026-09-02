import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { Mandate } from "@kairos/domain";
import { sealMandate, verifyMandate } from "@kairos/terminus";
import { explainMandate } from "./explain.js";
import { handle } from "./routes.js";
import { type MandateSpec, toMandate } from "./spec.js";

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
 * ```
 */
const USAGE = `kairos-mandate — author, sign, and read a mandate

  form [--port N]        Serve the authoring form on 127.0.0.1. Seals only if the secret is set.
  seal [spec.json]       Read a spec (file, or stdin), print the signed mandate to stdout.
                         The plain-English reading goes to stderr, so you see what you signed
                         even when redirecting stdout to a file.
  explain [mandate.json] Print what a signed mandate authorises, in words.
  verify [mandate.json]  Exit 0 if the signature is this secret's, 1 if it is not.

KAIROS_MANDATE_SECRET must be at least 32 characters. There is no development default:
a mandate signed with a publicly-known key is a mandate anyone can forge.
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
  default:
    process.stdout.write(USAGE);
    process.exit(command === undefined || command === "--help" || command === "-h" ? 0 : 2);
}
