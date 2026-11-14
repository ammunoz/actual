/**
 * Public surface of the import-review domain layer.
 *
 * This barrel is what the client imports. It is deliberately small: the
 * client needs the resolver, the review-state reducer, the split primitives,
 * and the types that flow between them. Everything else stays private to the
 * layer.
 *
 * The layer is pure — no React, no filesystem, no database, no `send()`.
 * That is what makes the whole review workflow testable against fixtures,
 * and what keeps the seam with Actual's engine one-directional: Actual's
 * handlers never see these types.
 */

export type {
  Flag,
  FlagCode,
  FlagKind,
  PayeeMatchSource,
  ResolvedRow,
  ReviewAccount,
  ReviewCategory,
  ReviewPayee,
  ReviewPayeeRule,
  ReviewRowInput,
  TrustLevel,
  VendorMap,
} from './types';

export { flagFor, gateByTrustLevel, outcomeFor } from './resolver/flags';
export type { GateOutcome, GateResult } from './resolver/flags';

export { canonicalize, strip } from './resolver/strip';
export type { StripResult, StripRule } from './resolver/strip';

export {
  fuzzyMatchPayees,
  fuzzyScore,
  lcsLength,
  lcsRatio,
  partialRatio,
  tokenSetRatio,
} from './resolver/fuzzy';
export type {
  FuzzyMatch,
  FuzzyMatchOpts,
  FuzzyPayeeCandidate,
} from './resolver/fuzzy';

export { resolvePayees } from './resolver/payee-resolver';
export type { FuzzyResolveOpts, ResolveOpts } from './resolver/payee-resolver';

export {
  applyDecision,
  buildPreviewState,
  effectiveAmountCents,
  effectiveTransferAccountId,
  isSplitRow,
  PreviewStateError,
  PREVIEW_STATE_NOT_FOUND,
  rowKey,
  summarize,
  updateEdits,
} from './preview/preview-state';
export type {
  ImportPreviewState,
  PreviewDecision,
  PreviewEdits,
  PreviewRow,
  PreviewSummary,
} from './preview/preview-state';

export {
  addLeg,
  MAX_SPLIT_LEGS,
  removeLeg,
  replaceLeg,
  seedSplit,
  splitResidualCents,
  splitResidualDirection,
  splitTotalCents,
  uncategorizedLegCount,
  validateSplit,
} from './preview/split-primitives';
export type {
  PreviewSplitLeg,
  SplitErrorCode,
  SplitResidualDirection,
} from './preview/split-primitives';

export {
  emptyVendorMap,
  filterStaleVendorMapEntries,
  upsertVendorMapEntry,
  validateVendorMap,
  VendorMapValidationError,
  VENDOR_MAP_CURRENT_V,
  VENDOR_MAP_MIN_SUPPORTED_V,
} from './vendor-map/types';
export type { VendorMapErrorCode } from './vendor-map/types';
