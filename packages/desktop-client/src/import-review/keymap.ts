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
  | 'edit-category'
  | 'edit-memo'
  | 'edit-amount'
  | 'edit-date'
  | 'edit-transfer'
  | 'edit-split'
  | 'cycle-flag'
  | 'save-session'
  | 'accept-all'
  | 'drop-all'
  | 'apply'
  | 'close'
  | 'help';

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
 * `ctrl+shift+a` is the override: it accepts a row the trust level is
 * holding back. It has a binding of its own rather than overloading
 * `ctrl+a`, because `ctrl+a` already means "accept this row without moving
 * on" and a binding whose meaning depends on the state of the row under the
 * cursor is one the user cannot predict.
 */
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
    keys: 'e',
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
    keys: 'tab',
    action: 'cycle-flag',
    showInHelp: true,
  },
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

/**
 * The trust levels, in the order the cycle key walks them.
 */
export const TRUST_LEVELS: readonly ('paranoid' | 'cautious' | 'trusted')[] =
  Object.freeze(['paranoid', 'cautious', 'trusted']);

/**
 * Pure: the next trust level in the cycle.
 */
export function nextTrustLevel(
  current: 'paranoid' | 'cautious' | 'trusted',
): 'paranoid' | 'cautious' | 'trusted' {
  const index = TRUST_LEVELS.indexOf(current);
  return TRUST_LEVELS[(index + 1) % TRUST_LEVELS.length];
}
