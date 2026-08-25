/**
 * Razorpay's names for the institutions Kairos tracks.
 *
 * Netbanking and card issuers are identified by their IFSC bank code, not by the shorthand a human
 * would use — Axis is `UTIB`, State Bank is `SBIN` — so a slice cannot be rendered into a checkout
 * configuration without a translation step. Getting one wrong is not a loud failure: an unknown
 * code produces a `hide` entry that matches nothing, so the steer silently does nothing while still
 * counting as treatment in the analysis. That is the failure this table exists to prevent, and it
 * is why {@link bankCode} returns `null` rather than guessing.
 */
const BANK_CODES: Readonly<Record<string, string>> = {
  hdfc: "HDFC",
  icici: "ICIC",
  sbi: "SBIN",
  axis: "UTIB",
  kotak: "KKBK",
  pnb: "PUNB",
  bob: "BARB",
  canara: "CNRB",
  yes: "YESB",
  idfc: "IDFB",
  indusind: "INDB",
  federal: "FDRL",
  rbl: "RATN",
  union: "UBIN",
};

/** Card networks, as Checkout spells them. */
const NETWORKS: Readonly<Record<string, string>> = {
  visa: "Visa",
  mastercard: "MasterCard",
  rupay: "RuPay",
  amex: "Amex",
  diners: "DinersClub",
  maestro: "Maestro",
};

/** Wallet providers, which Checkout names in lower case. */
const WALLETS: Readonly<Record<string, string>> = {
  paytm: "paytm",
  amazonpay: "amazonpay",
  phonepe: "phonepe",
  freecharge: "freecharge",
  mobikwik: "mobikwik",
  olamoney: "olamoney",
  jiomoney: "jiomoney",
  airtelmoney: "airtelmoney",
};

/** UPI apps addressable on the intent flow. */
const UPI_APPS: Readonly<Record<string, string>> = {
  gpay: "google_pay",
  phonepe: "phonepe",
  paytm: "paytm",
  bhim: "bhim",
  cred: "cred",
};

/** Pay-later providers. */
const PROVIDERS: Readonly<Record<string, string>> = {
  lazypay: "lazypay",
  simpl: "simpl",
  icic: "icic",
  getsimpl: "getsimpl",
};

function lookup(table: Readonly<Record<string, string>>, key: string | null): string | null {
  if (key === null) return null;
  return table[key.toLowerCase()] ?? null;
}

export const bankCode = (issuer: string | null): string | null => lookup(BANK_CODES, issuer);
export const networkCode = (network: string | null): string | null => lookup(NETWORKS, network);
export const walletCode = (wallet: string | null): string | null => lookup(WALLETS, wallet);
export const upiAppCode = (app: string | null): string | null => lookup(UPI_APPS, app);
export const providerCode = (provider: string | null): string | null => lookup(PROVIDERS, provider);

/** Every institution this adapter can name, for a startup check against the configured profiles. */
export function knownIssuers(): readonly string[] {
  return Object.keys(BANK_CODES);
}
