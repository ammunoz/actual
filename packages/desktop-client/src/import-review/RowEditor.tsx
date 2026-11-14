import { useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type {
  PreviewEdits,
  PreviewRow,
  ReviewCategory,
  ReviewPayee,
} from '@actual-app/core/server/transactions/import/review/index';

import {
  initialTextForMode,
  parseAmountText,
  parseDateText,
} from './editor-mode';
import type { EditorMode } from './editor-mode';
import { EditorPicker } from './EditorPicker';

export type RowEditorProps = {
  /** The row being edited. */
  row: PreviewRow;
  /** Which field is being edited. */
  mode: EditorMode;
  /** The budget's payees. */
  payees: readonly ReviewPayee[];
  /** The budget's categories. */
  categories: readonly ReviewCategory[];
  /**
   * Commit the edit.
   *
   * `chosenPayeeId` is the id of the payee the user picked, when they
   * picked one that already exists. It is what the vendor map records: the
   * raw vendor string is worth remembering so the next import of the same
   * file resolves to the same payee without asking.
   */
  onCommit: (edits: PreviewEdits, chosenPayeeId?: string) => void;
};

/**
 * A text field that commits on enter.
 */
function TextField({
  label,
  initialText,
  errorText,
  isValid,
  onCommit,
}: {
  label: string;
  initialText: string;
  errorText?: string;
  isValid: (text: string) => boolean;
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState(initialText);
  const [refused, setRefused] = useState(false);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!isValid(text)) {
      setRefused(true);
      return;
    }
    onCommit(text);
  };

  return (
    <View style={{ gap: 4 }}>
      <Text>{label}</Text>
      <Input
        value={text}
        autoFocus
        data-testid="import-review-editor-input"
        onChangeValue={value => {
          setText(value);
          setRefused(false);
        }}
        onKeyDown={onKeyDown}
      />
      {refused && errorText ? (
        <Text style={{ color: theme.errorText }}>{errorText}</Text>
      ) : null}
    </View>
  );
}
/**
 * The editing pane: the field the user is editing for the focused row.
 *
 * The pane sits BELOW the table, so the row being edited stays visible
 * while it is edited. It is the only place the keyboard goes while it is
 * open: the review's own bindings are switched off, so `tab` does not
 * cycle the trust level and `escape` does not discard the review.
 */
export function RowEditor({
  row,
  mode,
  payees,
  categories,
  onCommit,
}: RowEditorProps) {
  const { t } = useTranslation();

  // A transfer payee is the hidden payee Actual keeps for one account.
  // It is not something the user picks as a vendor.
  const payeeSuggestions = useMemo(
    () =>
      payees
        .filter(payee => !payee.transferAcct)
        .map(payee => ({ id: payee.id, name: payee.name })),
    [payees],
  );

  const categorySuggestions = useMemo(
    () =>
      categories.map(category => ({ id: category.id, name: category.name })),
    [categories],
  );

  const categoryId = row.edits.categoryId ?? row.matchedCategoryId;
  const initialCategoryName =
    categorySuggestions.find(suggestion => suggestion.id === categoryId)
      ?.name ?? '';

  // The date the row would be imported with, which is not the date the
  // file supplied once the user has changed it.
  const effectiveDate = row.edits.date ?? row.date;

  return (
    <View
      data-testid="import-review-editor"
      data-field={mode}
      style={{
        gap: 8,
        padding: 8,
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 6,
      }}
    >
      <Text>
        {t('Editing {{date}} — {{payee}}', {
          date: effectiveDate,
          payee: row.payeeRaw,
        })}
      </Text>

      {mode === 'payee' ? (
        <EditorPicker
          label={t('Payee')}
          suggestions={payeeSuggestions}
          initialText={initialTextForMode('payee', row)}
          allowNew
          errorText={t('No payee matches that name')}
          onPick={(suggestion, text) => {
            onCommit(
              {
                ...row.edits,
                payeeCanonical: suggestion ? suggestion.name : text.trim(),
              },
              suggestion?.id,
            );
          }}
        />
      ) : null}

      {mode === 'category' ? (
        <EditorPicker
          label={t('Category')}
          suggestions={categorySuggestions}
          initialText={initialTextForMode('category', row, {
            categoryName: initialCategoryName,
          })}
          // The import does not create categories, so a name the budget
          // does not have is not a choice.
          allowNew={false}
          errorText={t('No category matches that name')}
          onPick={(suggestion, _text) => {
            onCommit({
              ...row.edits,
              // An empty name clears the category: the row is imported
              // without one and Actual's rules decide.
              categoryId: suggestion ? suggestion.id : undefined,
            });
          }}
        />
      ) : null}

      {mode === 'memo' ? (
        <TextField
          label={t('Notes')}
          initialText={initialTextForMode('memo', row)}
          // Anything is a valid note, so this field never refuses.
          isValid={() => true}
          onCommit={text => {
            onCommit({ ...row.edits, memo: text });
          }}
        />
      ) : null}

      {mode === 'amount' ? (
        <TextField
          label={t('Amount')}
          initialText={initialTextForMode('amount', row)}
          errorText={t('Enter an amount like -25.00')}
          isValid={text => parseAmountText(text) !== null}
          onCommit={text => {
            const cents = parseAmountText(text);
            if (cents === null) return;
            onCommit({ ...row.edits, amountCents: cents });
          }}
        />
      ) : null}

      {mode === 'date' ? (
        <TextField
          label={t('Date')}
          initialText={initialTextForMode('date', row)}
          errorText={t('That is not a date')}
          isValid={text => parseDateText(text) !== null}
          onCommit={text => {
            const date = parseDateText(text);
            if (date === null) return;
            onCommit({ ...row.edits, date });
          }}
        />
      ) : null}

      <Text style={{ color: theme.warningText }}>
        {t('Enter to confirm · Escape to cancel')}
      </Text>
    </View>
  );
}
