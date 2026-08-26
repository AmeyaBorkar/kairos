export {
  DEFAULT_PROHIBITED,
  type GauntletOptions,
  type Rejection,
  type RejectionCode,
  type Verdict,
  validate,
} from "./gauntlet.js";
export { type HonestyVerdict, verifyExplanation } from "./honesty.js";
export {
  COPY_LIBRARY,
  Copy,
  type CopyLibrary,
  isWellFormedSegmentKey,
  type LibraryProvenance,
  type LibraryStats,
  parseLibrary,
  serialiseLibrary,
  statsFor,
} from "./library.js";
export type {
  ComposeRequest,
  Composer,
  Explainer,
  ExplanationRequest,
  ModelResult,
  ProposedCopy,
  TimelineEntry,
} from "./port.js";
export {
  type ModelPrice,
  NO_USAGE,
  priceOf,
  reservationFor,
  type Usage,
  usdPerMillionToPaise,
} from "./price.js";
export {
  CLASSES,
  type ClassifyRequest,
  classifyPrompt,
  composePrompt,
  explainPrompt,
  type Prompt,
  promptHash,
} from "./prompt.js";
export {
  CONTACT_CHANNELS,
  type ContactChannel,
  type CopySegment,
  type Coverage,
  parseSegmentKey,
  requiredSegments,
  SENDING_CLASSES,
  type Situation,
  segmentFor,
  segmentKey,
} from "./segment.js";
export {
  type CopyRequest,
  type CopySource,
  libraryCopy,
  type SelectedCopy,
} from "./source.js";
export {
  type BodyBudget,
  bodyBudget,
  type CopyVariant,
  DEFAULT_WORST_CASE,
  makeVariant,
  measure,
  PLACEHOLDERS,
  type Placeholder,
  type RenderedMessage,
  render,
  type WorstCase,
} from "./variant.js";
