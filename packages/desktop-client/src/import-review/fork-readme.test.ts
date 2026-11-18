import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { KEYMAP } from './keymap';

/**
 * The fork's README lists the review's keys.
 *
 * A document that restates the keymap goes stale: the
 * code owns the keymap, and a copy of it in a Markdown file drifts the
 * day somebody adds a key. So the copy is CHECKED, here, against the
 * code — and a key that the README does not mention, or a key the README
 * mentions that the review does not have, fails this test.
 *
 * Only the KEYS are checked. The README says what each one does in its
 * own words, and a rewording is not a drift; a key that is not there any
 * more is.
 */

/** The fork's document, at the root of the repository. */
const README_PATH = join(__dirname, '..', '..', '..', '..', 'FORK.md');

/**
 * How the README writes a key, and how the keymap writes the same key.
 *
 * The README writes the keys the way a person reads them — `G` for
 * shift+g, `Esc` for escape, `?` for the help — and the keymap
 * writes them the way `react-hotkeys-hook` wants: `shift+g`, `escape`,
 * `shift+slash`.
 */
const KEY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  esc: 'escape',
  '?': 'shift+slash',
  '↓': 'down',
  '↑': 'up',
  // A key the README writes in a notation the keymap does not use is
  // deliberately NOT mapped: it falls through as itself, and the test
  // then says the README lists a key the review does not bind, which is
  // the truth.
});

const MODIFIER_NAMES: Readonly<Record<string, string>> = Object.freeze({
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  cmd: 'cmd',
  command: 'cmd',
  meta: 'meta',
  alt: 'alt',
});

/** One key, as the keymap spells it. */
function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  return KEY_NAMES[lower] ?? lower;
}

/**
 * One cell of the README's table, as the keymap spells its keys.
 *
 * A cell can hold several keys — `j / k` is two — separated by a slash.
 * Each is either a single key or a modifier and a key.
 */
function bindingsInCell(cell: string): string[] {
  return cell.split(' / ').flatMap(combo => {
    const parts = [...combo.matchAll(/<kbd>(.*?)<\/kbd>/g)].map(match =>
      match[1].trim(),
    );
    if (parts.length === 0) return [];
    if (parts.length === 1) {
      const key = parts[0];
      // A bare capital LETTER is the shifted key, the way the review's
      // own hint strip writes it: `G` is shift+g. A digit and an arrow
      // are not letters, and they are not shifted either.
      if (/^[A-Z]$/.test(key)) {
        return [`shift+${key.toLowerCase()}`];
      }
      return [normalizeKey(key)];
    }
    const key = normalizeKey(parts[parts.length - 1]);
    const modifiers = parts
      .slice(0, -1)
      .map(
        modifier =>
          MODIFIER_NAMES[modifier.toLowerCase()] ?? modifier.toLowerCase(),
      );
    return [[...modifiers, key].join('+')];
  });
}

/** The keys the README's table lists. */
function readmeBindings(): string[] {
  const readme = readFileSync(README_PATH, 'utf8');
  const rows = readme
    .split('\n')
    .filter(line => line.trimStart().startsWith('| <kbd>'));
  if (rows.length === 0) {
    throw new Error(
      `No key table in ${README_PATH}: the rows start with "| <kbd>" and ` +
        `none of them do. The table may have been reformatted.`,
    );
  }
  return rows.flatMap(row => {
    const cells = row.split('|');
    // cells[0] is empty, because the row starts with the pipe.
    return bindingsInCell(cells[1] ?? '');
  });
}

/** The keys the keymap binds, one per hotkey. */
function keymapBindings(): string[] {
  // A binding can be a list — `j, down` — and the spacing around the
  // comma is the keymap's business, not this test's.
  return KEYMAP.flatMap(binding => binding.keys.split(/\s*,\s*/));
}

describe("the fork's README", () => {
  it('lists every key the review binds', () => {
    const listed = new Set(readmeBindings());
    const missing = keymapBindings().filter(binding => !listed.has(binding));
    expect(missing).toEqual([]);
  });

  it('lists no key the review does not bind', () => {
    // A key the README names but the review does not have is a promise
    // the app cannot keep.
    const bound = new Set(keymapBindings());
    const extra = readmeBindings().filter(binding => !bound.has(binding));
    expect(extra).toEqual([]);
  });
});
