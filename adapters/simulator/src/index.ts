export {
  BASELINE_FAILURES,
  DEGRADATION_FAILURES,
  drawFailure,
  type FailureTemplate,
} from "./failures.js";
export {
  type Degradation,
  degradationEndsAt,
  failureRateAt,
  generate,
  isDegraded,
  type SimulatorConfig,
} from "./generate.js";
export { blendedFailureRate, INDIA_PROFILES, type SliceProfile } from "./profiles.js";
export { Rng } from "./rng.js";
