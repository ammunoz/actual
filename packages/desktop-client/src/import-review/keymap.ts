/**
 * The review's keymap.
 *
 * Declarative so that it can be rendered as a help overlay and asserted in
 * tests without a DOM. The dispatch lives in the modal; this file only says
 * what each key means.
 *
 * The modal has its own hotkey scope (Actual's `Modal` component enables a
 * scope named after the modal and disables the `app` scope while it is
 * open), so these bindings never collide with the app-level shortcuts.
 */

import type { TrustLevel } from './types';

export type ReviewAction =
  | 'move-next'
  | 'move-prev'
  | 'move-first'
  | 'move-last'
  | 'accept'
  | 'accept-confirm'
  | 'accept-override'
  | 'drop'
  | 'undo'
  | 'edit-payee'
  | 'edit-chain'
  | 'edit-category'
  | 'edit-memo'
  | 'edit-amount'
  | 'edit-date'
  | 'edit-transfer'
  | 'edit-split'
  | 'edit-rules'
  | 'trust-paranoid'
  | 'trust-cautious'
  | 'trust-trusted'
  | 'save-session'
  | 'accept-all'
  | 'drop-all'
  | 'apply'
  | 'close'
  | 'help';

/**
 * Every action the review has, in one list.
 *
 * The union above says what an action may BE; this says what the actions
 * ARE. TypeScript cannot read a union's members at runtime, so a test
 * that says "every action has a binding" needs the list.
 *
 * The two are kept honest by the compiler: the list must hold only real
 * actions, and the check below fails to compile if the union grows an
 * action the list does not have. An action nobody bound would otherwise
 * fall into the dispatch's default branch and do nothing at all — a
 * keypress that looks like the review is broken.
 */
export const REVIEW_ACTIONS = Object.freeze([
  'move-next',
  'move-prev',
  'move-first',
  'move-last',
  'accept',
  'accept-confirm',
  'accept-override',
  'drop',
  'undo',
  'edit-payee',
  'edit-chain',
  'edit-category',
  'edit-memo',
  'edit-amount',
  'edit-date',
  'edit-transfer',
  'edit-split',
  'edit-rules',
  'trust-paranoid',
  'trust-cautious',
  'trust-trusted',
  'save-session',
  'accept-all',
  'drop-all',
  'apply',
  'close',
  'help',
] as const satisfies readonly ReviewAction[]);

/**
 * The list covers the whole union.
 *
 * If an action is added to `ReviewAction` and not to `REVIEW_ACTIONS`,
 * this stops being `true` and the file does not compile.
 */
type EveryActionIsListed =
  Exclude<ReviewAction, (typeof REVIEW_ACTIONS)[number]> extends never
    ? true
    : never;
export const REVIEW_ACTIONS_COVER_EVERY_ACTION: EveryActionIsListed = true;

export type KeyBinding = {
  /**
   * The keys, in `react-hotkeys-hook`'s own syntax, comma separated.
   *
   * The library lowercases the whole string, so `'A'` and `'a'` are the SAME
   * hotkey to it — `'A'` would silently behave as plain `'a'`. The
   * uppercase variants are therefore spelled `'shift+a'` and `'shift+r'`,
   * which the library matches against the shift modifier.
   */
  keys: string;
  /** What the key does. */
  action: ReviewAction;
  /**
   * Whether the binding should be shown in the help overlay.
   *
   * The overlay's LABELS do not live here: they are translated text, and
   * a dynamic `t(binding.labelKey)` cannot be seen by the extractor, so the
   * strings would never reach the translations. They live in
   * `help-labels.tsx`, keyed by action, where the extractor finds them.
   */
  showInHelp?: boolean;
};

/**
 * The hotkey scope the review's own bindings live in.
 *
 * It is the same name as the modal, because upstream's `Modal` component
 * enables the scope named after it: that is how the review's keys stop
 * firing once the modal is closed.
 */
export const REVIEW_SCOPE = 'keyboard-import-transactions';

/**
 * The bindings, in the order they appear in the help overlay.
 *
 * The key strings are in `react-hotkeys-hook`'s own syntax, and the library
 * matches on the NORMALIZED key code — `Digit4` becomes `4`, and `Slash`
 * becomes `slash` — so a character like `$` or `?` can never match. The
 * amount editor is therefore bound to `shift+4`, which is `$` on a US
 * layout, and the help overlay to `shift+slash`, which is `?`. Both are
 * real keys the library can match.
 *
 * `h`/`l` (switch OFX source account) is deliberately absent: Actual's OFX
 * parser discards `ACCTID`, so a multi-account OFX file cannot be addressed
 * without a change to upstream's `ofx2json.ts`.
 *
 * `w` puts the review aside: the decisions and the edits are saved on this
 * device, and the command bar brings the review back.
 *
 * `o` is deliberately absent: it used to route the rows to another
 * account. A file is imported into the account the review was opened for,
 * because Actual's OFX parser discards the bank's account id, and the
 * boundaries between two statements in one file cannot be recovered from
 * the file itself. Splitting such a file is the user's to do upstream.
 *
 * `ctrl+shift+a` is the override: it accepts a row the trust level is
 * holding back. It has a binding of its own rather than overloading
 * `ctrl+a`, because `ctrl+a` already means "accept this row without moving
 * on" and a binding whose meaning depends on the state of the row under the
 * cursor is one the user cannot predict.
 */
/**
 * The trust levels, in the order the header control shows them.
 */
export const TRUST_LEVELS: readonly TrustLevel[] = Object.freeze([
  'paranoid',
  'cautious',
  'trusted',
]);

/**
 * The key that selects each trust level.
 *
 * The chips in the header and the key bindings are ONE fact: the chip
 * says the key that does what the chip does. Deriving the digit from the
 * array index would let a reorder desynchronize them, so the digits live
 * here and the bindings are made from them.
 */
export const TRUST_LEVEL_KEYS = Object.freeze({
  paranoid: '1',
  cautious: '2',
  trusted: '3',
} as const);

/**
 * The bindings that select the trust levels, made from the table above.
 */
const TRUST_BINDINGS: readonly KeyBinding[] = TRUST_LEVELS.map(level => ({
  keys: TRUST_LEVEL_KEYS[level],
  action: `trust-${level}`,
  showInHelp: true,
}));

/**
 * The actions that are about the REVIEW, not about the row under the
 * cursor.
 *
 * These stay live while a button or another control has the focus. The
 * row actions belong to the grid, and a focused control must not swallow
 * them: with the close button focused, `a` used to accept the focused
 * row.
 *
 * - Escape closes the review, and the dialog is told NOT to dismiss
 *   itself on Escape, so this is the only way out.
 * - Ctrl+S applies the import, and it is advertised on the very button
 *   that might have the focus.
 * - `w` puts the review aside, and `?` opens the help.
 * - The bulk actions and the undo work on the whole review.
 * - The trust keys select a level for the whole review.
 *
 * The two lists together are every action the review has, and a test
 * says so: an action nobody classified would be a row action by
 * default, which is the safe way round.
 */
export const GLOBAL_ACTIONS: readonly ReviewAction[] = Object.freeze([
  'close',
  'apply',
  'save-session',
  'help',
  'accept-all',
  'drop-all',
  'undo',
  'trust-paranoid',
  'trust-cautious',
  'trust-trusted',
]);

/**
 * The actions that act on the row under the cursor.
 */
export const ROW_ACTIONS: readonly ReviewAction[] = Object.freeze([
  'move-next',
  'move-prev',
  'move-first',
  'move-last',
  'accept',
  'accept-confirm',
  'accept-override',
  'drop',
  'edit-payee',
  'edit-chain',
  'edit-category',
  'edit-memo',
  'edit-amount',
  'edit-date',
  'edit-transfer',
  'edit-split',
  'edit-rules',
]);

export const KEYMAP: readonly KeyBinding[] = Object.freeze([
  {
    keys: 'j, down',
    action: 'move-next',
    showInHelp: true,
  },
  {
    keys: 'k, up',
    action: 'move-prev',
    showInHelp: true,
  },
  { keys: 'g', action: 'move-first', showInHelp: true },
  {
    keys: 'shift+g',
    action: 'move-last',
    showInHelp: true,
  },
  {
    keys: 'a',
    action: 'accept',
    showInHelp: true,
  },
  {
    keys: 'ctrl+a',
    action: 'accept-confirm',
    showInHelp: true,
  },
  {
    keys: 'ctrl+shift+a',
    action: 'accept-override',
    showInHelp: true,
  },
  {
    keys: 'r',
    action: 'drop',
    showInHelp: true,
  },
  {
    keys: 'u',
    action: 'undo',
    showInHelp: true,
  },
  {
    // `e` walks the row: the payee, then the category, then the notes,
    // then the amount if the row is flagged about it. One keypress, one
    // row finished — so it is the key the row's own actions show.
    keys: 'e',
    action: 'edit-chain',
    showInHelp: true,
  },
  {
    // `p` is the payee ALONE. It was free, and the chain needs a key
    // for the single field.
    keys: 'p',
    action: 'edit-payee',
    showInHelp: true,
  },
  {
    keys: 'c',
    action: 'edit-category',
    showInHelp: true,
  },
  { keys: 'm', action: 'edit-memo', showInHelp: true },
  {
    keys: 'shift+4',
    action: 'edit-amount',
    showInHelp: true,
  },
  {
    keys: 'd',
    action: 'edit-date',
    showInHelp: true,
  },
  {
    keys: 't',
    action: 'edit-transfer',
    showInHelp: true,
  },
  {
    keys: 's',
    action: 'edit-split',
    showInHelp: true,
  },
  {
    // `shift+e` opens the rules that touched this row. It is a SHIFTED
    // key because the plain letters are the field editors, and the rules
    // are about the row rather than about one field.
    keys: 'shift+e',
    action: 'edit-rules',
    showInHelp: true,
  },
  // `tab` is deliberately NOT bound: a dialog has to be tabbable. The
  // trust level is a control with three direct keys instead of a cycle,
  // and the keys come from the table above.
  ...TRUST_BINDINGS,
  {
    keys: 'w',
    action: 'save-session',
    showInHelp: true,
  },
  {
    keys: 'shift+a',
    action: 'accept-all',
    showInHelp: true,
  },
  {
    keys: 'shift+r',
    action: 'drop-all',
    showInHelp: true,
  },
  {
    keys: 'ctrl+s',
    action: 'apply',
    showInHelp: true,
  },
  {
    keys: 'escape',
    action: 'close',
    showInHelp: true,
  },
  {
    keys: 'shift+slash',
    action: 'help',
    showInHelp: true,
  },
]);

/**
 * The action a hotkey string refers to.
 *
 * `react-hotkeys-hook` splits a comma-separated key list into separate
 * hotkeys and reports the one that matched as `hotkey`. A binding of
 * `'j, down'` therefore registers two hotkeys, `'j'` and `'down'`, and the
 * lookup has to consider each of them.
 *
 * The comparison is on the hotkey string, not on the parsed key list: for
 * `ctrl+a` and `a` the parsed key list is `['a']` in both cases, so it
 * cannot tell them apart.
 */
export function actionForHotkey(hotkey: string): ReviewAction | undefined {
  const lower = hotkey.toLowerCase();
  for (const binding of KEYMAP) {
    if (binding.keys.split(', ').some(keys => keys.toLowerCase() === lower)) {
      return binding.action;
    }
  }
  return undefined;
}

/**
 * The actions that end the review, in the order they are offered.
 */
export const CLOSING_ACTIONS: readonly ReviewAction[] = Object.freeze([
  'apply',
  'close',
]);
