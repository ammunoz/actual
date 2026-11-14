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
  | 'edit-transfer'
  | 'edit-split'
  | 'cycle-flag'
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
  /** Label for the help overlay. */
  /**
   * The i18n key for the help overlay label. It is a KEY, not display
   * text: whoever renders the overlay has to translate it.
   */
  labelKey: string;
  /** Whether the binding should be shown in the help overlay. */
  showInHelp?: boolean;
};

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
    labelKey: 'Next row',
    showInHelp: true,
  },
  {
    keys: 'k, up',
    action: 'move-prev',
    labelKey: 'Previous row',
    showInHelp: true,
  },
  { keys: 'g', action: 'move-first', labelKey: 'First row', showInHelp: true },
  {
    keys: 'shift+g',
    action: 'move-last',
    labelKey: 'Last row',
    showInHelp: true,
  },
  {
    keys: 'a',
    action: 'accept',
    labelKey: 'Accept row and advance',
    showInHelp: true,
  },
  {
    keys: 'ctrl+a',
    action: 'accept-confirm',
    labelKey: 'Accept row (confirm)',
    showInHelp: true,
  },
  {
    keys: 'ctrl+shift+a',
    action: 'accept-override',
    labelKey: 'Accept row despite its flags',
    showInHelp: true,
  },
  {
    keys: 'r',
    action: 'drop',
    labelKey: 'Drop row and advance',
    showInHelp: true,
  },
  {
    keys: 'u',
    action: 'undo',
    labelKey: 'Undo last decision',
    showInHelp: true,
  },
  {
    keys: 'e',
    action: 'edit-payee',
    labelKey: 'Edit payee',
    showInHelp: true,
  },
  {
    keys: 'c',
    action: 'edit-category',
    labelKey: 'Edit category',
    showInHelp: true,
  },
  { keys: 'm', action: 'edit-memo', labelKey: 'Edit notes', showInHelp: true },
  {
    keys: 'shift+4',
    action: 'edit-amount',
    labelKey: 'Edit amount',
    showInHelp: true,
  },
  {
    keys: 't',
    action: 'edit-transfer',
    labelKey: 'Set transfer target',
    showInHelp: true,
  },
  { keys: 's', action: 'edit-split', labelKey: 'Edit split', showInHelp: true },
  {
    keys: 'tab',
    action: 'cycle-flag',
    labelKey: 'Cycle trust level',
    showInHelp: true,
  },
  {
    keys: 'shift+a',
    action: 'accept-all',
    labelKey: 'Accept every row',
    showInHelp: true,
  },
  {
    keys: 'shift+r',
    action: 'drop-all',
    labelKey: 'Drop every row',
    showInHelp: true,
  },
  {
    keys: 'ctrl+s',
    action: 'apply',
    labelKey: 'Apply the import',
    showInHelp: true,
  },
  {
    keys: 'escape',
    action: 'close',
    labelKey: 'Discard and close',
    showInHelp: true,
  },
  {
    keys: 'shift+slash',
    action: 'help',
    labelKey: 'Show this help',
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
