/**
 * Pure payee resolver. Applies the priority:
 *
 *   0. vendor map (exact key match on `payeeRaw` against the user's
 *      per-budget dictionary of explicit confirmations)
 *   1. user payee rules (sorted by pattern length desc, enabled only)
 *   t. transfer detection: exact case-insensitive match of `payeeRaw`
 *      against a budget account name — the row becomes a transfer,
 *      flagged `transfer-detected` so the review says so
 *   2. longest-prefix match against existing budget payees
 *      (length >= 4 OR word-boundary; transfer payees excluded)
 *   3. fuzzy LCS-ratio match against canonicalized raw (if enabled;
 *      transfer payees excluded from candidates)
 *   4. `canonicalize(strip(raw))` fallback
 *   else -> 'none' (canonical = '')
 *
 * The vendor map (Layer 0) wins over user rules (Layer 1) because the
 * dictionary represents explicit user confirmations; a heuristic rule should
 * never override a deliberate mapping.
 *
 * The transfer layer sits after rules (a user rule mapping an
 * account-named string to a vendor is deliberate) and before prefix/fuzzy
 * matching (an exact account-name hit must beat a fuzzy payee hit). Layers
 * 2 and 3 exclude transfer payees: their display name IS an account name, so
 * matching against them would silently convert ordinary transactions into
 * transfers.
 *
 * Layer 3 runs BEFORE the strip-fallback because strip can produce a
 * degraded canonical that wouldn't fuzzy-match a real budget payee name. By
 * comparing the canonicalized raw against the budget's payee list at Layer 3,
 * we catch typos and partial-name matches even when strip yields a
 * non-empty result. Strip-fallback at Layer 4 is the last resort.
 *
 * Layer 3 fuzzy matches are intentionally flagged with
 * `fuzzy-payee-match / PAYEE-FUZZY-001` so the UI can show the match isn't
 * an exact hit and prompt the user to accept it or edit it.
 *
 * Immutable: input arrays and rows are not mutated. Every returned
 * `ResolvedRow` is a freshly-spread object; every internal index/sort
 * produces a new array.
 *
 * Privacy: no payee values are echoed into thrown messages. The resolver
 * accepts them, processes them, and returns them.
 */

import type {
  PayeeMatchSource,
  ResolvedRow,
  ReviewAccount,
  ReviewPayee,
  ReviewPayeeRule,
  ReviewRowInput,
  VendorMap,
} from '#server/transactions/import/review/types';

import { flagFor } from './flags';
import { fuzzyMatchPayees } from './fuzzy';
import { canonicalize } from './strip';

export type FuzzyResolveOpts = {
  /** Minimum score to keep a fuzzy match. Default 0.6. */
  minScore?: number;
  /** Cap fuzzy matches per row. Default 5. */
  maxResults?: number;
};

export type ResolveOpts = {
  /** Budget payees to match against. */
  existingPayees: readonly ReviewPayee[];
  /**
   * Budget accounts, used by the transfer-detection layer: an exact
   * case-insensitive match of `payeeRaw` against an account name pre-fills
   * the row as a transfer. Optional; when absent, transfer auto-detect is a
   * no-op.
   */
  accounts?: readonly ReviewAccount[];
  /** User payee rules. Optional; when absent, Layer 1 is a no-op. */
  rules?: readonly ReviewPayeeRule[];
  /** The vendor dictionary. Optional; when absent, Layer 0 is a no-op. */
  vendorMap?: VendorMap;
  /** Fuzzy options. Optional; when absent, Layer 3 is disabled. */
  fuzzy?: FuzzyResolveOpts;
};

type IndexEntry = {
  id: string;
  lower: string;
  original: string;
};

type CompiledRule = ReviewPayeeRule & {
  readonly _re?: RegExp;
};

const MIN_PREFIX_LEN_BOUNDARY_FREE = 4;
// The minimum score for a fuzzy match to be kept.
//
// This matches the fuzzy module's own default. A lower threshold admits
// clearly wrong matches: "Demo Grocery Store" against "Online store" scores
// 0.667, and "Demo Payroll Deposit" against "Home Depot" scores 0.600, while
// a real typo like "Demo Cofee Shop" against "Demo Coffee Shop" scores 0.968.
const DEFAULT_FUZZY_MIN_SCORE = 0.7;
const DEFAULT_FUZZY_MAX_RESULTS = 5;

/**
 * Pure: resolve the payee for every row. Returns a new array; the input is
 * not mutated.
 */
export function resolvePayees(
  rows: readonly ReviewRowInput[],
  opts: ResolveOpts,
): readonly ResolvedRow[] {
  const sortedRules = compileRules(opts.rules ?? []);
  const existingIndex = buildExistingIndex(opts.existingPayees);
  // Transfer-detection index: exact case-insensitive account-name lookup.
  // Includes closed accounts (still valid transfer targets).
  const accountsIndex = buildAccountsIndex(opts.accounts);

  const out: ResolvedRow[] = [];
  for (const row of rows) {
    out.push(resolveOne(row, sortedRules, existingIndex, accountsIndex, opts));
  }
  return out;
}

function resolveOne(
  row: ReviewRowInput,
  rules: readonly CompiledRule[],
  existingIndex: readonly IndexEntry[],
  accountsIndex: readonly IndexEntry[],
  opts: ResolveOpts,
): ResolvedRow {
  const raw = row.payeeRaw;

  // Layer 0: vendor map (exact key match on payeeRaw).
  if (opts.vendorMap) {
    const payeeId = opts.vendorMap.entries[raw];
    if (payeeId !== undefined) {
      const hit = existingIndex.find(p => p.id === payeeId);
      if (hit) {
        return resolved(row, hit.original, 'vendor-map', hit.id);
      }
      // Stale entry: the payee id from the dictionary no longer exists in
      // the budget's payee list. Fall through to Layer 1. We do NOT prune
      // the stale entry here — that would mutate the caller-provided store.
    }
  }

  // Layer 1: user payee rules.
  for (const rule of rules) {
    if (ruleMatches(rule, raw)) {
      return resolved(
        row,
        rule.canonicalName,
        'rule',
        undefined,
        rule.categoryId,
      );
    }
  }

  // Transfer-detection layer: exact case-insensitive match of the raw payee
  // string against a budget account name. Auto-detects the row as a
  // transfer and flags it, so the review says so. Runs before Layer 2 so
  // an exact account name beats a prefix match on the same string.
  //
  // The row's OWN account is never a transfer target: a transaction cannot
  // transfer to the account it is in. The manual picker already refuses it
  // (it is the account the user is looking at), and the auto-detect has to
  // refuse it too, or a file whose vendor string happens to equal the
  // account's own name would import as a transfer to itself.
  const rawLower = raw.toLowerCase();
  if (accountsIndex.length > 0) {
    const acct = accountsIndex.find(
      a => a.lower === rawLower && a.id !== row.accountId,
    );
    if (acct) {
      const base = resolved(row, acct.original, 'transfer', undefined);
      base.matchedTransferAccountId = acct.id;
      return flagFor(
        base,
        'transfer-detected',
        'PAYEE-TRANSFER-001',
        `account=${acct.id}`,
      );
    }
  }

  // Layer 2: longest-prefix against existing budget payees (raw). Transfer
  // payees are excluded from the index so a vendor string cannot prefix- or
  // fuzzy-match its way into silently becoming a transfer.
  const txnLower = raw.toLowerCase();
  const prefixHit = findLongestPrefix(txnLower, existingIndex);
  if (prefixHit !== null) {
    return resolved(row, prefixHit.original, 'existing-prefix', prefixHit.id);
  }

  // Layer 3: fuzzy LCS-ratio match against canonicalized raw.
  if (opts.fuzzy && existingIndex.length > 0) {
    const candidates = existingIndex.map(p => ({
      id: p.id,
      name: p.original,
    }));
    const matches = fuzzyMatchPayees(raw, candidates, {
      minScore: opts.fuzzy.minScore ?? DEFAULT_FUZZY_MIN_SCORE,
      maxResults: opts.fuzzy.maxResults ?? DEFAULT_FUZZY_MAX_RESULTS,
    });
    const top = matches[0];
    if (top) {
      const base = resolved(row, top.candidate.name, 'fuzzy', top.candidate.id);
      return flagFor(
        base,
        'fuzzy-payee-match',
        'PAYEE-FUZZY-001',
        `score=${top.score.toFixed(2)}`,
      );
    }
  }

  // Layer 4: strip fallback (only when no budget match found).
  const stripped = canonicalize(raw);
  if (stripped !== '') {
    const fallback = resolved(row, stripped, 'strip-fallback', undefined);
    // Attached only when there are existing budget payees to compare
    // against. On a first-run budget (empty payee list) every import would
    // otherwise be flagged, which is noise — the apply step creates the
    // payee naturally and the user has nothing to map.
    if (existingIndex.length > 0 || accountsIndex.length > 0) {
      return flagFor(
        fallback,
        'would-create-payee',
        'PAYEE-NEW-001',
        `canonical=${stripped}`,
      );
    }
    return fallback;
  }

  // Layer 5: unknown-payee.
  const noneRow = resolved(row, '', 'none', undefined);
  if (existingIndex.length === 0 && accountsIndex.length === 0) {
    return noneRow;
  }
  return flagFor(noneRow, 'unknown-payee', 'PAYEE-UNK-001');
}

function resolved(
  row: ReviewRowInput,
  canonical: string,
  source: PayeeMatchSource,
  matchedPayeeId: string | undefined,
  matchedCategoryId?: string,
): ResolvedRow {
  const out: ResolvedRow = {
    ...row,
    payeeCanonical: canonical,
    payeeMatchSource: source,
    // Copied, not aliased: the caller's array must not stay reachable from
    // the returned row.
    flags: row.flags ? [...row.flags] : [],
  };
  if (matchedPayeeId !== undefined) out.matchedPayeeId = matchedPayeeId;
  if (matchedCategoryId !== undefined) {
    out.matchedCategoryId = matchedCategoryId;
  }
  return out;
}

/**
 * Pure: compile the rules into matchable form, longest pattern first so a
 * more specific rule wins over a broader one.
 */
function compileRules(
  rules: readonly ReviewPayeeRule[],
): readonly CompiledRule[] {
  // A rule whose pattern is not a valid regular expression is skipped
  // rather than thrown: the pattern comes from the user's own rules, and one
  // broken rule must not abort the whole import.
  const compiled: CompiledRule[] = [];
  const ordered = [...rules]
    .filter(r => r.enabled)
    .sort((a, b) => b.pattern.length - a.pattern.length);
  for (const rule of ordered) {
    if (rule.patternKind !== 'regex') {
      compiled.push(rule);
      continue;
    }
    try {
      compiled.push({
        ...rule,
        _re: new RegExp(rule.pattern, rule.patternFlags ?? ''),
      });
    } catch {
      // An invalid pattern: the rule cannot match, so it is skipped.
      continue;
    }
  }
  return compiled;
}

function buildExistingIndex(
  payees: readonly ReviewPayee[],
): readonly IndexEntry[] {
  return (
    payees
      // Transfer payees (one hidden payee per account, `transfer_acct` set) are
      // excluded from prefix/fuzzy matching entirely: their display name IS
      // the account name, so letting a vendor string prefix- or fuzzy-match
      // them would silently convert ordinary transactions into transfers.
      //
      // The check has to be nullish, not `=== undefined`: Actual's `payees`
      // column is nullable and the API returns `null` for an ordinary payee,
      // so `=== undefined` would exclude every ordinary payee and leave the
      // prefix and fuzzy layers with nothing to match against.
      .filter(p => p.transferAcct == null)
      .map(p => ({
        id: p.id,
        lower: p.name.toLowerCase(),
        original: p.name,
      }))
      .sort((a, b) => b.lower.length - a.lower.length)
  );
}

function buildAccountsIndex(
  accounts: readonly ReviewAccount[] | undefined,
): readonly IndexEntry[] {
  if (!accounts || accounts.length === 0) return [];
  return accounts.map(a => ({
    id: a.id,
    lower: a.name.toLowerCase(),
    original: a.name,
  }));
}

function findLongestPrefix(
  txnLower: string,
  index: readonly IndexEntry[],
): IndexEntry | null {
  for (const entry of index) {
    if (entry.lower.length > txnLower.length) continue;
    if (!txnLower.startsWith(entry.lower)) continue;
    if (entry.lower.length >= MIN_PREFIX_LEN_BOUNDARY_FREE) {
      return entry;
    }
    const nextChar = txnLower.charAt(entry.lower.length);
    if (nextChar === '' || !/\w/.test(nextChar)) {
      return entry;
    }
  }
  return null;
}

function ruleMatches(rule: CompiledRule, raw: string): boolean {
  switch (rule.patternKind) {
    case 'contains': {
      return raw.toLowerCase().includes(rule.pattern.toLowerCase());
    }
    case 'prefix': {
      return raw.toLowerCase().startsWith(rule.pattern.toLowerCase());
    }
    case 'regex': {
      return (rule._re as RegExp).test(raw);
    }
    default: {
      return false;
    }
  }
}
