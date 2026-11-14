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
  /** The key as `react-hotkeys-hook` spells it. */
  keys: string;
  /** What the key does. */
  action: ReviewAction;
  /** Label for the help overlay. */
  label: string;
  /** Whether the binding should be shown in the help overlay. */
  showInHelp?: boolean;
};

/**
 * The bindings, in the order they appear in the help overlay.
 *
 * `h`/`l` (switch OFX source account) is deliberately absent: Actual's OFX
 * parser discards `ACCTID`, so a multi-account OFX file cannot be addressed
 * without a change to upstream's `ofx2json.ts`.
 */
export const KEYMAP: readonly KeyBinding[] = Object.freeze([
  { keys: 'j, down', action: 'move-next', label: 'Next row', showInHelp: true },
  {
    keys: 'k, up',
    action: 'move-prev',
    label: 'Previous row',
    showInHelp: true,
  },
  { keys: 'g', action: 'move-first', label: 'First row', showInHelp: true },
  { keys: 'G', action: 'move-last', label: 'Last row', showInHelp: true },
  {
    keys: 'a',
    action: 'accept',
    label: 'Accept row and advance',
    showInHelp: true,
  },
  {
    keys: 'ctrl+a',
    action: 'accept-confirm',
    label: 'Accept row (confirm)',
    showInHelp: true,
  },
  {
    keys: 'r',
    action: 'drop',
    label: 'Drop row and advance',
    showInHelp: true,
  },
  { keys: 'u', action: 'undo', label: 'Undo last decision', showInHelp: true },
  { keys: 'e', action: 'edit-payee', label: 'Edit payee', showInHelp: true },
  {
    keys: 'c',
    action: 'edit-category',
    label: 'Edit category',
    showInHelp: true,
  },
  { keys: 'm', action: 'edit-memo', label: 'Edit notes', showInHelp: true },
  { keys: '$', action: 'edit-amount', label: 'Edit amount', showInHelp: true },
  {
    keys: 't',
    action: 'edit-transfer',
    label: 'Set transfer target',
    showInHelp: true,
  },
  { keys: 's', action: 'edit-split', label: 'Edit split', showInHelp: true },
  {
    keys: 'tab',
    action: 'cycle-flag',
    label: 'Cycle trust level',
    showInHelp: true,
  },
  {
    keys: 'A',
    action: 'accept-all',
    label: 'Accept every row',
    showInHelp: true,
  },
  { keys: 'R', action: 'drop-all', label: 'Drop every row', showInHelp: true },
  {
    keys: 'ctrl+s',
    action: 'apply',
    label: 'Apply the import',
    showInHelp: true,
  },
  {
    keys: 'escape',
    action: 'close',
    label: 'Discard and close',
    showInHelp: true,
  },
  { keys: '?', action: 'help', label: 'Show this help', showInHelp: true },
]);

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
