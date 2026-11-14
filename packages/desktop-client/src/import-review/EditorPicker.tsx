import { useId, useMemo, useState } from 'react';
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
}: EditorPickerProps) {
  const [text, setText] = useState(initialText);
  // The field starts out showing a name, so the highlight starts on that
  // name — if the budget has it.
  const [highlight, setHighlight] = useState(() =>
    exactMatchIndex(filterSuggestions(suggestions, initialText), initialText),
  );
  const [refused, setRefused] = useState(false);

  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  const matches = useMemo(
    () => filterSuggestions(suggestions, text),
    [suggestions, text],
  );

  const pick = (suggestion: EditorSuggestion | null, value: string) => {
    onPick(suggestion, value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // The caret would jump to the start or the end of the field, which
      // is not what the arrow keys mean here.
      event.preventDefault();
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
        autoFocus
        // The list is a listbox and the highlighted entry is pointed at
        // from the field, so a screen reader says which suggestion is
        // about to be picked.
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={matches.length > 0}
        aria-controls={matches.length > 0 ? listboxId : undefined}
        aria-activedescendant={highlight >= 0 ? optionId(highlight) : undefined}
        data-testid="import-review-editor-input"
        onChangeValue={value => {
          setText(value);
          setRefused(false);
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

      {matches.length > 0 ? (
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
          {matches.map((suggestion, index) => (
            <View
              key={suggestion.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === highlight}
              data-testid="import-review-editor-option"
              data-highlighted={index === highlight ? 'true' : 'false'}
              onClick={() => pick(suggestion, suggestion.name)}
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
          ))}
        </View>
      ) : null}
    </View>
  );
}
