/**
 * Structural payee-string normalization. Pure functional.
 *
 * Patterns are FORMAT-driven, never vendor-driven. Adding a new rule
 * requires editing this file and asserting its id is unique.
 *
 * Identity guarantee: applying `strip()` to an already-canonical string is
 * a no-op (idempotent). `canonicalize()` returns just the result string;
 * `strip()` returns both the canonical form and the rule-indices that fired
 * so the flag pipeline can produce a code-tagged message.
 *
 * Rules are tried in declared order, repeatedly up to a fixed pass count,
 * so combinations like "INTERAC DEPOSIT FOO INC" converge cleanly.
 *
 * Scope notes:
 *   - A standalone trailing all-caps city token is NOT stripped.
 *     Distinguishing merchant-name fragments from city tails is unreliable
 *     without external knowledge; the resolver's longest-prefix layer
 *     handles city-tail narrowing against the user's actual payee list.
 */

export type StripResult = {
  canonical: string;
  /** 1-based indices of the rules that fired, in the order they fired. */
  fired: number[];
};

export type StripRule = {
  /** Stable rule id; matched against flag-builder codes. */
  code: string;
  /** Human-readable rationale; surfaces in a flag note. */
  description: string;
  apply: (input: string) => { next: string; fired: boolean };
};

export const STRIP_RULES: readonly StripRule[] = Object.freeze([
  {
    code: 'collapse-whitespace',
    description: 'Collapse runs of whitespace to a single space',
    apply: input => {
      const next = input.replace(/\s+/g, ' ');
      return { next, fired: next !== input };
    },
  },
  {
    code: 'trim-bounds',
    description: 'Trim leading/trailing whitespace',
    apply: input => {
      const next = input.trim();
      return { next, fired: next !== input };
    },
  },
  {
    code: 'interac-prefix',
    description: 'Strip Interac e-transfer network prefix',
    apply: input => {
      const next = input.replace(/^FREE\s+INTERAC\s+E-TRANSFER\s+/i, '');
      return { next, fired: next !== input };
    },
  },
  {
    code: 'pos-prefix',
    description: 'Strip POS purchase prefixes (OPOS / POS / SP)',
    apply: input => {
      const next = input.replace(/^(OPOS|POS|SP)\s+/i, '');
      return { next, fired: next !== input };
    },
  },
  {
    code: 'trail-prov-state',
    description: 'Strip trailing "<CITY>, <ST>"',
    apply: input => {
      const next = input.replace(/,?\s+[A-Z]{2}$/, '');
      return { next, fired: next !== input };
    },
  },
  {
    code: 'trail-store-number',
    description: 'Strip trailing 4+ digit store number',
    apply: input => {
      const next = input.replace(/\s+\d{4,}$/, '');
      return { next, fired: next !== input };
    },
  },
  {
    code: 'trail-corp-suffix',
    description: 'Strip trailing corporate suffix (Inc / Ltd / Co / Corp)',
    apply: input => {
      const next = input.replace(/\s+(Inc\.?|Ltd\.?|Co\.?|Corp\.?)$/i, '');
      return { next, fired: next !== input };
    },
  },
]);

const MAX_PASSES = 4;

/**
 * Pure: normalize a raw vendor string. Returns the canonical form and the
 * indices of the rules that fired.
 */
export function strip(input: string | null | undefined): StripResult {
  if (input == null) return { canonical: '', fired: [] };
  let current = input;
  const fired: number[] = [];
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let anyFired = false;
    for (let i = 0; i < STRIP_RULES.length; i++) {
      const rule = STRIP_RULES[i];
      const { next, fired: didFire } = rule.apply(current);
      if (didFire) {
        if (!fired.includes(i + 1)) fired.push(i + 1);
        current = next;
        anyFired = true;
      }
    }
    if (!anyFired) break;
  }
  return { canonical: current, fired };
}

/**
 * Pure: the canonical form of a raw vendor string.
 */
export function canonicalize(input: string | null | undefined): string {
  if (input == null) return '';
  return strip(input).canonical;
}
