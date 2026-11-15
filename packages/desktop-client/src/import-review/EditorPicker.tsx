import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import {
  exactMatchIndex,
  filterSuggestions,
  nextHighlightIndex,
} from './editor-mode';
import type { EditorSuggestion } from './editor-mode';

export type EditorPickerProps = {
  /** The label of the field. */
  label: string;
  /** Every suggestion the user can pick from. */
  suggestions: readonly EditorSuggestion[];
  /** The text the field starts out showing. */
  initialText: string;
  /**
   * Whether a name that matches no suggestion can be picked.
   *
   * A payee can be created by the import, so a name the budget does not
   * have yet is a legitimate choice. A category cannot: the import does
   * not create categories.
   */
  allowNew: boolean;
  /**
   * The message shown when the user confirms a name that matches nothing
   * and cannot be created.
   */
  errorText: string;
  /**
   * Called with the picked suggestion, or with `null` when the user typed a
   * name that matches nothing.
   *
   * The picker does NOT close itself: whether the pick is acceptable is the
   * caller's business, and the caller may refuse it.
   */
  onPick: (suggestion: EditorSuggestion | null, text: string) => void;
  /**
   * Whether the field takes the focus when it mounts.
   *
   * A pane with one picker wants it. A pane with a picker per leg does NOT:
   * every mounted field would claim the focus, and the last one to mount
   * would win.
   */
  autoFocus?: boolean;
  /** The test id of the field. */
  testId?: string;
};

/**
 * A text field with a filtered list of suggestions under it.
 *
 * Keyboard-first, because the review is keyboard-driven: the user types to
 * filter, the arrow keys move the highlight, and enter picks the highlighted
 * suggestion. The mouse works too, but it is not the point.
 *
 * The highlight is the EXACT match and nothing else. A name the budget does
 * not have stays unhighlighted, so confirming it means "a payee called
 * this", not "the payee whose name starts with this". A user who wants the
 * near match arrows down to it.
 *
 * The picker is deliberately not upstream's `Autocomplete`: that component
 * reports its selection asynchronously and cannot tell "the user picked the
 * payee called X" from "the user typed a name that happens to be called X",
 * and the review needs to know which payee id was picked — that id is what
 * the vendor map records.
 */
export function EditorPicker({
  label,
  suggestions,
  initialText,
  allowNew,
  errorText,
  onPick,
  autoFocus = true,
  testId = 'import-review-editor-input',
}: EditorPickerProps) {
  const [text, setText] = useState(initialText);
  // The field starts out showing a name, so the highlight starts on that
  // name — if the budget has it.
  const [highlight, setHighlight] = useState(() =>
    exactMatchIndex(filterSuggestions(suggestions, initialText), initialText),
  );
  const [refused, setRefused] = useState(false);
  // The value the field last committed.
  //
  // The field is uncontrolled — the text the user is typing is a filter,
  // not a choice — so this is what the field goes back to when it loses
  // the focus without a pick.
  const [committedText, setCommittedText] = useState(initialText);

  // The field follows the value it was given when that value changes,
  // the way the text field does. Nothing changes a suggestion's value
  // from outside the picker today, but a picker that could be
  // pre-filled programmatically would otherwise show a stale name.
  const [shownInitialText, setShownInitialText] = useState(initialText);
  if (initialText !== shownInitialText) {
    setShownInitialText(initialText);
    setCommittedText(initialText);
    setText(initialText);
    setRefused(false);
  }
  // Whether the list of suggestions is OPEN.
  //
  // The list is open while the user is CHOOSING and closed once they
  // have chosen. A picker that always shows its list is fine when there
  // is ONE picker, but the split editor has one per leg: twenty open
  // lists would bury the table they belong to.
  //
  // It closes on a pick, which is also what upstream's payee picker
  // does. It has to: the list sits between the field and the buttons
  // below it, so a list that closed on blur would move those buttons
  // out from under the pointer — and the click that was aimed at "Save"
  // would land on nothing at all.
  const [listOpen, setListOpen] = useState(autoFocus);

  // Whether a pointer is currently DOWN.
  //
  // The list must not close WHILE one is. The list sits between the
  // field and the controls below it, so closing it on the blur that a
  // press causes would move those controls out from under the pointer
  // between the press and the release — and the click would land on
  // nothing at all. The user presses "Save", nothing happens, and
  // nothing says why.
  const pointerIsDown = useRef(false);

  // The listener that closes the list once a press is over.
  //
  // It is held in a ref so that it can be taken off again: a listener
  // that outlives its picker is a leak, and a leaked one would close a
  // list that is no longer there.
  const deferredClose = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!listOpen) return;
    const onPointerDown = () => {
      pointerIsDown.current = true;
    };
    // A pointer that is CANCELLED — a touch that turns into a scroll, a
    // drag that leaves the window — is not down any more. Without this
    // the flag would latch, and every later blur would leave the list
    // open.
    const onPointerEnd = () => {
      pointerIsDown.current = false;
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerEnd, true);
    document.addEventListener('pointercancel', onPointerEnd, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerEnd, true);
      document.removeEventListener('pointercancel', onPointerEnd, true);
      // The flag goes back to false with the listeners: a pick closes
      // the list, which unmounts this effect, and the pointer that comes
      // up afterwards is never seen. A flag left set would make every
      // later blur defer the close to a pointerup that is not coming.
      pointerIsDown.current = false;
    };
  }, [listOpen]);

  // The picker goes away with its pending listener.
  useEffect(() => {
    return () => {
      const pending = deferredClose.current;
      if (pending) {
        document.removeEventListener('pointerup', pending, true);
        document.removeEventListener('pointercancel', pending, true);
        deferredClose.current = null;
      }
    };
  }, []);

  // Close the list, unless a press is in progress.
  //
  // A press that is under way finishes first: the list closes when the
  // pointer comes up, so the control the user aimed at is still where
  // they left it when the click lands.
  const closeList = () => {
    if (!pointerIsDown.current) {
      setListOpen(false);
      return;
    }
    // A press is under way: the list closes when the pointer comes up,
    // so the control the user aimed at is still where they left it when
    // the click lands.
    const pending = deferredClose.current;
    if (pending) {
      document.removeEventListener('pointerup', pending, true);
      document.removeEventListener('pointercancel', pending, true);
    }
    const onPointerEnd = () => {
      // The listener takes itself off: it is done, and a listener that
      // outlives its job is a leak that holds the picker alive.
      document.removeEventListener('pointerup', onPointerEnd, true);
      document.removeEventListener('pointercancel', onPointerEnd, true);
      deferredClose.current = null;
      setListOpen(false);
    };
    deferredClose.current = onPointerEnd;
    document.addEventListener('pointerup', onPointerEnd, true);
    document.addEventListener('pointercancel', onPointerEnd, true);
  };

  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  const matches = useMemo(
    () => filterSuggestions(suggestions, text),
    [suggestions, text],
  );

  const pick = (suggestion: EditorSuggestion | null, value: string) => {
    // The field shows what was picked, rather than keeping the
    // half-typed name that was never chosen.
    if (suggestion) setText(suggestion.name);
    setCommittedText(value);
    // The choice is made, so the list closes.
    setListOpen(false);
    // The pointer that made the choice is still down, and the list's
    // closing unmounts the tracking that would have cleared the flag.
    pointerIsDown.current = false;
    onPick(suggestion, value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // The caret would jump to the start or the end of the field, which
      // is not what the arrow keys mean here.
      event.preventDefault();
      setListOpen(true);
      setHighlight(current =>
        nextHighlightIndex(
          matches.length,
          current,
          event.key === 'ArrowDown' ? 1 : -1,
        ),
      );
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const suggestion = highlight >= 0 ? matches[highlight] : undefined;
      if (suggestion) {
        pick(suggestion, suggestion.name);
        return;
      }
      if (allowNew || text.trim() === '') {
        pick(null, text);
        return;
      }
      // A name that matches nothing and cannot be created is refused. The
      // user is told why rather than being left wondering.
      setRefused(true);
    }
  };

  return (
    <View style={{ gap: 4 }}>
      <Text>{label}</Text>
      <Input
        value={text}
        autoFocus={autoFocus}
        // The list is a listbox and the highlighted entry is pointed at
        // from the field, so a screen reader says which suggestion is
        // about to be picked.
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={listOpen && matches.length > 0}
        aria-controls={listOpen && matches.length > 0 ? listboxId : undefined}
        aria-activedescendant={
          listOpen && highlight >= 0 ? optionId(highlight) : undefined
        }
        data-testid={testId}
        onFocus={() => setListOpen(true)}
        // Clicking a field that already has the focus does not fire
        // `focus` again, so the list is reopened here: a user who has
        // picked something and then changed their mind clicks the field.
        onClick={() => setListOpen(true)}
        onBlur={() => {
          closeList();
          // A field that loses the focus without a pick goes back to
          // the value it last committed: the text the user typed was a
          // filter, not a choice.
          if (text !== committedText) {
            setText(committedText);
            setRefused(false);
          }
        }}
        onChangeValue={value => {
          setText(value);
          setRefused(false);
          // Typing is choosing, so the list opens again.
          setListOpen(true);
          // The list just changed underneath the highlight, so the
          // highlight goes back to the exact match — and to nothing at
          // all when the name is one the budget does not have.
          const next = filterSuggestions(suggestions, value);
          setHighlight(exactMatchIndex(next, value));
        }}
        onKeyDown={onKeyDown}
      />

      {refused ? (
        <Text style={{ color: theme.errorText }}>{errorText}</Text>
      ) : null}

      {listOpen && matches.length > 0 ? (
        <View
          id={listboxId}
          role="listbox"
          style={{
            border: `1px solid ${theme.tableBorder}`,
            borderRadius: 4,
            maxHeight: 160,
            overflowY: 'auto',
          }}
        >
          {matches.map((suggestion, index) => {
            // The group is shown once, as a header, at the top of its
            // suggestions. The suggestions are in group order, so the
            // header appears exactly where its group starts.
            const groupName = suggestion.groupName;
            const showGroup =
              groupName !== undefined &&
              groupName !== matches[index - 1]?.groupName;

            return (
              <View key={suggestion.id}>
                {showGroup ? (
                  <View
                    data-testid="import-review-editor-group"
                    style={{
                      padding: '4px 8px 0',
                    }}
                  >
                    <Text style={{ color: theme.pageTextSubdued }}>
                      {groupName}
                    </Text>
                  </View>
                ) : null}

                <View
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === highlight}
                  // The accessible name carries the group, so a screen
                  // reader says which of two same-named categories is
                  // meant. The visible name is still the start of it.
                  aria-label={
                    groupName
                      ? `${suggestion.name}, ${groupName}`
                      : suggestion.name
                  }
                  data-testid="import-review-editor-option"
                  data-highlighted={index === highlight ? 'true' : 'false'}
                  // The pick happens on MOUSE DOWN, not on click: the
                  // input loses the focus when the mouse goes down, and
                  // the blur closes the list — so a click would land on
                  // a list that is already gone. Preventing the default
                  // keeps the focus on the input, and the list stays
                  // open until the pick has been made.
                  onMouseDown={event => {
                    event.preventDefault();
                    pick(suggestion, suggestion.name);
                  }}
                  // A click that a screen reader or the keyboard
                  // synthesised carries no pointer detail, and it never
                  // had a mouse down: that is the only path assistive
                  // activation has.
                  onClick={event => {
                    if (event.detail === 0) pick(suggestion, suggestion.name);
                  }}
                  style={{
                    padding: '4px 8px',
                    cursor: 'default',
                    backgroundColor:
                      index === highlight
                        ? theme.menuAutoCompleteBackgroundHover
                        : 'transparent',
                  }}
                >
                  <Text>{suggestion.name}</Text>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
