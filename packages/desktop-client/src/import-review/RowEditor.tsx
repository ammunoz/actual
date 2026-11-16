import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { withPayee } from '@actual-app/core/server/transactions/import/review/index';
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
import type { EditorMode, EditorSuggestion } from './editor-mode';
import { EditorPicker } from './EditorPicker';
import { TextField } from './TextField';

/**
 * Pure: the payee the row has now, by id.
 *
 * The user's pick is a NAME — the edits carry no payee id — so it is
 * matched back to the budget's payees by name. The resolver's payee is
 * an id already, but it may be a transfer payee, which is not in the
 * list, so it is only offered if it is.
 */
function resolvePayeeId(
  row: PreviewRow,
  payeeText: string,
  suggestions: readonly EditorSuggestion[],
): string | undefined {
  if (row.edits.payeeCanonical !== undefined) {
    const wanted = payeeText.trim().toLowerCase();
    return suggestions.find(
      suggestion => suggestion.name.trim().toLowerCase() === wanted,
    )?.id;
  }
  return suggestions.some(suggestion => suggestion.id === row.matchedPayeeId)
    ? row.matchedPayeeId
    : undefined;
}

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

  // The group name comes along, so the picker can show which group a
  // category is in. Two categories with the same name in different
  // groups are otherwise indistinguishable, which is the one thing the
  // group name was carried for.
  const categorySuggestions = useMemo(
    () =>
      categories.map(category => ({
        id: category.id,
        name: category.name,
        groupName: category.groupName,
      })),
    [categories],
  );

  // The payee the row has now: the one the user picked, or the one the
  // resolver found.
  const payeeText = initialTextForMode('payee', row);
  const payeeId = resolvePayeeId(row, payeeText, payeeSuggestions);

  const categoryId = row.edits.categoryId;
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
          initialText={payeeText}
          allowNew
          errorText={t('No payee matches that name')}
          // The row's own payee, by id: two payees can have the same
          // name.
          initialSuggestionId={payeeId}
          onPick={(suggestion, text) => {
            onCommit(
              withPayee(row.edits, suggestion ? suggestion.name : text.trim()),
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
          // The row's own category, by id: two categories can have the
          // same name in different groups.
          initialSuggestionId={categoryId}
          onPick={(suggestion, _text) => {
            onCommit({
              ...row.edits,
              // An empty name CLEARS the category: the row is imported
              // without one and Actual's rules decide.
              //
              // It is not `undefined`, which means "the user has not
              // picked one": a cleared category is work the user did, and
              // the review has to be able to tell it from a row they
              // never looked at.
              categoryId: suggestion ? suggestion.id : '',
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

      <Text style={{ color: theme.pageTextSubdued }}>
        {t('Enter to confirm · Escape to cancel')}
      </Text>
    </View>
  );
}
