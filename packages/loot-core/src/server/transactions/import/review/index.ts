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

export {
  flagDuplicateFitids,
  flagFor,
  isHardBlock,
  outcomeFor,
} from './resolver/flags';
export type { GateOutcome } from './resolver/flags';

export { rebuildPreviewState } from './preview/rebuild';

export {
  accountForRow,
  defaultGroups,
  distinctAccounts,
  groupAt,
  groupRanges,
  isSameRouting,
  isValidRouting,
  rowsOfGroup,
  setAllRowsAccount,
  setRowAccount,
} from './routing/groups';
export type { GroupRange, RowGroup } from './routing/groups';

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
  evaluateRows,
  isSplitRow,
  PreviewStateError,
  PREVIEW_STATE_NOT_FOUND,
  rowKey,
  summarize,
  unsavedWork,
  updateEdits,
  validateSplitRow,
  validateTransferRow,
  withCarriedWork,
  withPayee,
  withSplit,
  withTransfer,
  withTrustLevel,
} from './preview/preview-state';
export type {
  ImportPreviewState,
  PreviewDecision,
  PreviewEdits,
  PreviewRow,
  PreviewSummary,
  UnsavedWork,
} from './preview/preview-state';

export {
  effectiveFlags,
  evaluateRow,
  gateFromFlags,
  gateRow,
  isUsableDate,
  normalizePayeeName,
} from './preview/gating';
export type { GateOpts, RowEvaluation, RowGate } from './preview/gating';

export {
  addLeg,
  MAX_SPLIT_LEGS,
  removeLeg,
  replaceLeg,
  seedSplit,
  splitResidualCents,
  splitResidualDirection,
  splitTotalCents,
  SplitValidationError,
  uncategorizedLegCount,
  validateSplit,
} from './preview/split-primitives';
export type {
  PreviewSplitLeg,
  SplitErrorCode,
  SplitResidualDirection,
} from './preview/split-primitives';

export { TransferValidationError } from './preview/transfer-primitives';
export type { TransferErrorCode } from './preview/transfer-primitives';

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
