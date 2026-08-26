/**
 * What the model is told, built as pure functions so it can be read, diffed and tested.
 *
 * Prompts here are not strings scattered through an adapter. They are the instructions a library of
 * customer-facing copy was written under, so they are versioned, hashed into that library's
 * provenance, and reviewable in a pull request like any other text that reaches a customer.
 *
 * ## What is deliberately absent
 *
 * No name, no phone number, no email address, no order id, no amount. Not because those are hard to
 * assemble but because **a field that is never assembled cannot be exfiltrated by a prompt that
 * asks for it** — the same argument `ResidualInput` in `@kairos/recover` is built on. The model is
 * told what kind of failure this is and who it is writing for in the abstract; it writes a sentence
 * with holes, and the holes are filled by a pure function on a machine that never talks to anyone.
 *
 * That is also what makes a provider's free tier acceptable for this. Free tiers generally reserve
 * the right to train on what they are sent. There is nothing here to learn.
 *
 * ## Structure
 *
 * The system half is identical for every call and comes first; the situation is small and comes
 * last. Providers that cache a prompt prefix cache on an exact byte match from the start, so the
 * ordering is what makes about a hundred and eighty calls cost roughly one prompt's worth of input.
 */

import { createHash } from "node:crypto";
import { LANGUAGE_SPECS, type PaymentMethod, type RecoverabilityClass } from "@kairos/domain";
import type { ComposeRequest, ExplanationRequest } from "./port.js";
import type { ContactChannel } from "./segment.js";

export interface Prompt {
  readonly system: string;
  readonly user: string;
}

/**
 * What each class of failure actually is, and what the customer has to do about it.
 *
 * Ours, not the model's. The whole argument for guided copy is that a message naming the real
 * problem recovers several times what a message reporting a failure does — so the model is *told*
 * the problem rather than asked to infer it from an error code. Inference is the classifier's job
 * and it has already happened by the time anyone gets here.
 */
const SITUATION: Readonly<Record<RecoverabilityClass, string>> = {
  transient: [
    "Their bank or payment rail was temporarily broken when they tried to pay. It was not their",
    "fault and nothing about their account or card is wrong. The outage is over now. All they have",
    "to do is tap the link and the payment will go through.",
  ].join(" "),
  timed: [
    "The payment failed because there was not enough money in the account at that moment. This is",
    "the most delicate case: never say or imply that they were short of funds, never mention a",
    "balance, and never suggest they check one. Say the payment did not complete and that they can",
    "finish it whenever they are ready.",
  ].join(" "),
  "customer-action": [
    "Something about their saved payment method needs fixing before any payment can succeed — an",
    "expired card, a mandate that needs re-authorising, a payment address that is no longer valid.",
    "They have to change something first. Say what needs fixing and point them at the link.",
  ].join(" "),
  "customer-retry": [
    "Nothing is broken and nothing needs fixing. They started paying and stopped — cancelled the",
    "request, closed the page, mistyped something. They simply have to try again. Be brief and",
    "completely unpushy: they may have changed their mind, and this is the only message they will",
    "get.",
  ].join(" "),
  unknown: [
    "The payment did not go through and we do not know why. Do not guess, do not name a cause, and",
    "do not imply anything is wrong with their account. Say it did not complete and offer the link.",
  ].join(" "),
  dead: "Never sent. If you are reading this, something is wrong upstream.",
};

/** What the customer physically does next, on each rail. The specificity that earns the uplift. */
const NEXT_ACTION: Readonly<Record<PaymentMethod, string>> = {
  upi: "open their UPI app and approve the request with their UPI PIN",
  card: "pay by card and enter the OTP their bank sends them",
  netbanking: "log in to their bank's site to authorise the payment",
  wallet: "top up or re-link their wallet and pay from it",
  emi: "re-confirm the EMI plan with their bank",
  paylater: "authorise the payment on their pay-later account",
};

const CHANNEL_RULES: Readonly<Record<ContactChannel, string>> = {
  "contact-sms": [
    "This is an SMS. Write one sentence, two at the very most. No line breaks, no emoji, no",
    "formatting, and no subject line. Every character is billed.",
  ].join(" "),
  "contact-whatsapp": [
    "This is a WhatsApp message. It can be slightly warmer and a little longer than an SMS, but",
    "still short. No emoji, no formatting, and no subject line.",
  ].join(" "),
  "contact-email": [
    "This is an email. Write a subject line of at most 60 characters and a body of two or three",
    "short sentences. No marketing framing, no signature, no images.",
  ].join(" "),
};

/**
 * The half of the prompt that never changes.
 *
 * Constant across every segment, deliberately, so a provider's prompt cache can serve it. Anything
 * varying that belongs here would cost the cache and be paid for on every one of the calls.
 */
function systemPrompt(): string {
  return [
    "You write transactional payment-recovery messages for an Indian merchant. A customer tried to",
    "pay, the payment failed, and your message is the one chance to bring them back. You are not",
    "writing marketing: the customer already wanted to buy, and your job is to remove whatever is",
    "in the way and get out of their way.",
    "",
    "What makes one of these messages work, in order of importance:",
    "",
    "1. Say what actually happened, specifically. 'Your HDFC netbanking was down' beats 'your",
    "   payment failed'. A person who understands the problem acts; a person told only that",
    "   something broke assumes it will break again.",
    "2. Say exactly what to do next, once. One action, not a choice of three.",
    "3. Be brief. This is read on a lock screen, in a queue, one-handed.",
    "4. Sound like a person at the merchant, not a bank's automated system and not a scam.",
    "",
    "Absolute rules. Breaking any of these means the message is discarded:",
    "",
    "- Use ONLY these placeholders, written exactly like this: {amount}, {link}, {institution}.",
    "  They are substituted later with the real values. {amount} and {link} must both appear.",
    "- Never write a rupee figure, a phone number, a reference number, or any URL of your own. If",
    "  you want to name a sum, write {amount}. If you want to link somewhere, write {link}.",
    "- Do NOT write a greeting or the customer's name. The message already opens with one, and",
    "  yours would be the second. Start with the substance.",
    "- Never promise a refund, a discount, a guarantee or a callback. Never manufacture urgency —",
    "  no deadlines, no warnings about the account, no 'last chance'.",
    "- Never ask the customer to share an OTP, a PIN or a password with anyone. Telling them their",
    "  bank will send an OTP is fine and often useful; asking for one is never.",
    "- Write in the language you are asked for, in that language's own script.",
  ].join("\n");
}

export interface ComposeVariables {
  readonly situation: string;
  readonly nextAction: string | null;
}

/**
 * The instructions for one situation.
 *
 * Short by construction: everything general lives in the system half, so what varies per call is a
 * few hundred characters. That ratio is the reason a whole library costs about one prompt's worth of
 * input rather than a hundred and eighty of them.
 */
export function composePrompt(request: ComposeRequest): Prompt {
  const { segment, variants, budget } = request;
  const spec = LANGUAGE_SPECS[segment.language];
  const method = segment.method;

  const lines = [
    `Language: ${spec.englishName} (${spec.name}), written in ${spec.script} script.`,
    CHANNEL_RULES[segment.channel],
  ];

  if (segment.channel !== "contact-email") {
    // The budget the model is given is the budget it can act on: the characters left for *its
    // text*, with the surcharge each placeholder adds once filled already taken out. Stating the
    // segment capacity instead — and asking it to subtract a greeting and three substitutions it
    // has never seen — is the version of this prompt that produced an eleven per cent acceptance
    // rate on the first recorded batch.
    lines.push(
      `Length: at most ${budget.characters} characters, counting {amount} and {link} exactly as` +
        " you type them. Room for the greeting and for the real values has already been taken out" +
        ` of this message's ${budget.capacity}, so the number is yours to spend and nothing else` +
        " comes out of it. Count it.",
      spec.gsm7
        ? "One character over doubles the price of every message ever sent from this text."
        : `${spec.englishName} is sent at sixteen bits per character, which is why this budget is` +
            " a fraction of what an English message gets. One character over doubles the price of" +
            " every message ever sent from this text. Be ruthless: cut every word that is not" +
            " load-bearing, and prefer the short way of saying a thing to the polite way.",
    );
  }

  lines.push("", "What happened to this customer:", SITUATION[segment.recoverability]);

  if (method !== null) {
    lines.push(
      "",
      `They were paying by ${method}. To finish, they need to ${NEXT_ACTION[method]}. Name that` +
        " specifically — it is the single most useful thing the message can contain.",
    );
  }

  lines.push(
    "",
    `Write ${variants} different versions. Make them genuinely different in approach, not the same` +
      " sentence reworded: they are going to be tested against each other on real customers, and" +
      " two near-identical options waste the test.",
  );

  return { system: systemPrompt(), user: lines.join("\n") };
}

/**
 * A stable fingerprint of the instructions a library was written under.
 *
 * Covers the system half and every fixed table the user half is built from, but not the individual
 * request — so it changes when the instructions change and not when the segment does. Recorded in
 * a library's provenance for the same reason the scorecard carries a config hash: copy written under
 * one set of instructions is not evidence about copy written under another.
 */
export function promptHash(): string {
  const material = JSON.stringify({
    system: systemPrompt(),
    situation: SITUATION,
    nextAction: NEXT_ACTION,
    channelRules: CHANNEL_RULES,
  });
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 16);
}

/**
 * The instructions for explaining a decision from the audit chain.
 *
 * The hard requirement is not fluency, it is that the answer cannot say anything the chain does not.
 * The records are handed over already retrieved and already redacted; the model's only job is to
 * turn a list into a sentence, and it is told plainly that inventing a reason is worse than saying
 * it does not know.
 */
export function explainPrompt(request: ExplanationRequest): Prompt {
  const system = [
    "You explain, to an operator at a payments company, why their system did what it did. You are",
    "given a verified audit trail: every entry is a real record from a hash-chained ledger.",
    "",
    "Rules:",
    "",
    "- Say only what the records say. If they do not answer the question, say so plainly and stop.",
    "  An honest 'the trail does not show that' is useful; a plausible guess is a liability.",
    "- When a decision was refused, name the limit that bound it. That is what the operator needs.",
    "- Do not invent amounts, times, customers or reasons. Every figure you use must appear above.",
    "- Three or four sentences. An operator is reading this to decide what to do next.",
  ].join("\n");

  const timeline = request.timeline
    .map(
      (entry) =>
        `- ${entry.at} ${entry.actor} ${entry.action} ${entry.allowed ? "ALLOWED" : "REFUSED"}` +
        `${entry.binding === null ? "" : ` (bound by: ${entry.binding})`} — ${entry.reason}`,
    )
    .join("\n");

  const user = [
    `Subject: ${request.subject}`,
    "",
    "Bounds in force:",
    ...request.bounds.map((bound) => `- ${bound}`),
    "",
    "Audit trail:",
    timeline.length === 0 ? "- (no records)" : timeline,
    "",
    `Question: ${request.question}`,
  ].join("\n");

  return { system, user };
}
