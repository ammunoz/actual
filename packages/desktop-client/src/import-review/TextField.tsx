import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

export type TextFieldProps = {
  /** The label of the field. */
  label: string;
  /** The text the field starts out showing. */
  initialText: string;
  /** The message shown when the text is refused. */
  errorText?: string;
  /** Whether the text the user typed may be confirmed. */
  isValid: (text: string) => boolean;
  /**
   * Whether the field takes the focus when it mounts.
   *
   * A pane with one field wants it. A pane with a field per leg does NOT:
   * every mounted field would claim the focus, and the last one to mount
   * would win.
   */
  autoFocus?: boolean;
  /** The test id of the input. */
  testId?: string;
  /**
   * Confirm the text.
   *
   * The field does NOT close itself: whether the text is acceptable is
   * the caller's business, and the caller may refuse it.
   */
  onCommit: (text: string) => void;
};

/**
 * A text field that commits on enter or on blur.
 *
 * It refuses text the caller says is not acceptable, and says why,
 * rather than committing something wrong. Blur committing matters for
 * a pane of several fields: clicking "Add leg" or "Save" blurs the
 * focused field before the button's handler runs, so the draft the
 * handler reads holds what the user typed rather than the value the
 * field showed when it mounted.
 */
export function TextField({
  label,
  initialText,
  errorText,
  isValid,
  autoFocus = true,
  testId = 'import-review-editor-input',
  onCommit,
}: TextFieldProps) {
  const [text, setText] = useState(initialText);
  const [refused, setRefused] = useState(false);
  // The last value handed to `onCommit`. Enter commits and the following
  // blur would otherwise commit the same text a second time — which is
  // harmless for an amount but would fire any side effect twice. A ref
  // (not state) also covers two commit paths firing before a re-render.
  // `onCommit` is assumed to APPLY unconditionally: every caller here
  // writes the value into its draft, which in turn updates `initialText`.
  const committedText = useRef(initialText);

  // The field follows the value it was given when that value changes.
  //
  // The field is uncontrolled — the text the user is typing cannot be
  // held in the draft, which holds cents — so without this the field
  // would keep showing the value the draft had when the field mounted.
  // That is how the split pane's "Distribute" button would leave the
  // amount fields showing amounts the draft no longer holds.
  //
  // The adjustment happens during the render rather than in an effect,
  // so the field never paints the stale value.
  const [shownInitialText, setShownInitialText] = useState(initialText);
  if (initialText !== shownInitialText) {
    setShownInitialText(initialText);
    setText(initialText);
    committedText.current = initialText;
    setRefused(false);
  }

  const commit = (value: string) => {
    if (!isValid(value)) {
      setRefused(true);
      return;
    }
    // An unacceptable value leaves the last good commit in place, so
    // Enter followed by blur (or blur alone) commits at most once.
    if (value === committedText.current) return;
    committedText.current = value;
    setRefused(false);
    onCommit(value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commit(text);
  };

  return (
    <View style={{ gap: 4 }}>
      <Text>{label}</Text>
      <Input
        value={text}
        autoFocus={autoFocus}
        data-testid={testId}
        onChangeValue={value => {
          setText(value);
          setRefused(false);
        }}
        onKeyDown={onKeyDown}
        onUpdate={commit}
      />
      {refused && errorText ? (
        <Text style={{ color: theme.errorText }}>{errorText}</Text>
      ) : null}
    </View>
  );
}
