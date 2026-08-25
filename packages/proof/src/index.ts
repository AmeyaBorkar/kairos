export {
  compare,
  type InvariantVerdict,
  type MetricVerdict,
  type Verdict,
} from "./compare.js";
export {
  checkInvariant,
  type InvariantCheck,
  type InvariantKind,
  type InvariantObservation,
  invariant,
} from "./invariant.js";
export {
  classify,
  type Direction,
  fails,
  formatDelta,
  formatValue,
  type GatedMetric,
  type Observation,
  type Outcome,
  toleranceShare,
  type Unit,
} from "./metric.js";
export {
  canonicalise,
  codeRevision,
  configHash,
  type JsonValue,
  type Provenance,
  provenance,
  type Runner,
} from "./provenance.js";
export { renderVerdict } from "./report.js";
export {
  BASELINE,
  type Baseline,
  type BlessResult,
  bless,
  parseBaseline,
  parseScorecard,
  SCORECARD,
  type Scorecard,
  serialiseBaseline,
} from "./scorecard.js";
export {
  DEFAULT_SIGMAS,
  type Spread,
  suggestTolerance,
  summarise,
} from "./variance.js";
