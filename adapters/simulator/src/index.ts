export { type AppliedPlan, type Choice, type ChoiceModel, chooseUnderPlan } from "./choice.js";
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
  generateLabelled,
  isDegraded,
  type LabelledAttempt,
  type SimulatorConfig,
} from "./generate.js";
export { blendedFailureRate, INDIA_PROFILES, type SliceProfile } from "./profiles.js";
export {
  type ActionContext,
  type ActionOutcome,
  type CasualtyClass,
  type ContactChannel,
  type Counterfactual,
  DEFAULT_RECOVERY_WORLD,
  RecoveryWorld,
  type RecoveryWorldConfig,
} from "./recovery.js";
export { Rng } from "./rng.js";
