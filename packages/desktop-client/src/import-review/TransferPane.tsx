import { useMemo, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import {
  effectiveTransferAccountId,
  withTransfer,
} from '@actual-app/core/server/transactions/import/review/index';
import type {
  PreviewEdits,
  PreviewRow,
  ReviewAccount,
  ReviewPayee,
} from '@actual-app/core/server/transactions/import/review/index';

import { EditorPicker } from './EditorPicker';
import { transferTargets } from './transfer-mode';

export type TransferPaneProps = {
  /** The row being turned into a transfer. */
  row: PreviewRow;
  /** The budget's accounts. */
  accounts: readonly ReviewAccount[];
  /** The budget's payees, which carry the hidden transfer payees. */
  payees: readonly ReviewPayee[];
  /**
   * The account the import is going INTO.
   *
   * A transfer to the account itself is not a transfer, so it is not
   * offered.
   */
  sourceAccountId: string;
  /**
   * Commit the transfer.
   *
   * The pane hands over the WHOLE edits object, not just the transfer:
   * `updateEdits` replaces a row's edits wholesale, so a commit that
   * carried only the transfer would throw away the payee, the notes and
   * the date the user had already set.
   */
  onCommit: (edits: PreviewEdits) => void;
};

/**
 * The transfer editor: the account a row moves money to.
 *
 * The pane sits BELOW the table, like the field editor, the split editor
 * and the help overlay, and it is a MODAL surface: the review's own
 * bindings are switched off while it is open, so the row cursor cannot
 * move out from under it. That is what makes Escape a reliable
 * "discard".
 *
 * It is a FORM, not a hotkey surface, exactly like the split editor.
 * Every action is a control the user can see, and the keyboard walks the
 * form in the ordinary way — Tab from field to field, Enter to confirm a
 * field — while Ctrl+Enter saves from anywhere, including from inside a
 * field, where the plain Enter belongs to the field.
 *
 * The transfer does NOT accept the row: accepting stays a separate
 * keystroke, so the user can set the transfer and then look at the row
 * before deciding what to do with it.
 */
export function TransferPane({
  row,
  accounts,
  payees,
  sourceAccountId,
  onCommit,
}: TransferPaneProps) {
  const { t } = useTranslation();

  // The target the row has NOW: the user's own choice, or the
  // resolver's auto-detect, which is a prefill and not a fact.
  const currentTargetId = effectiveTransferAccountId(row);

  // The draft: the account the row will transfer to.
  //
  // It lives here, in the pane, and not in the review's state: an
  // uncommitted transfer is not work the user would miss, and the review
  // must not be able to hold a half-finished one.
  const [targetId, setTargetId] = useState<string | undefined>(
    currentTargetId ?? undefined,
  );

  const targets = useMemo(
    () => transferTargets(accounts, payees, sourceAccountId),
    [accounts, payees, sourceAccountId],
  );

  const accountNames = useMemo(
    () => new Map(accounts.map(account => [account.id, account.name])),
    [accounts],
  );

  const targetName = targetId ? (accountNames.get(targetId) ?? '') : '';

  const commit = () => {
    if (targetId === undefined) return;
    onCommit(withTransfer(row.edits, targetId));
  };

  const removeTransfer = () => {
    // The empty string CLEARS the transfer, including the resolver's
    // auto-detect: `undefined` would only clear the user's own choice,
    // and the prefill would come back.
    onCommit(withTransfer(row.edits, ''));
  };

  // Ctrl+Enter saves the transfer from anywhere, including from inside
  // the field — where the plain Enter belongs to the field.
  //
  // The pane owns the keyboard while it is open: the review's own
  // bindings are switched off, and the app's are too, because the modal
  // disables the `app` scope. So this key is free.
  useHotkeys(
    'ctrl+enter',
    () => {
      commit();
    },
    {
      enableOnFormTags: true,
      // The hotkey and the button agree: there is nothing to save
      // until a target has been picked.
      enabled: targetId !== undefined,
    },
  );

  return (
    <View
      data-testid="import-review-transfer"
      style={{
        gap: 8,
        padding: 8,
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 6,
      }}
    >
      <Text>
        {t('Transferring {{date}} — {{payee}}', {
          date: row.edits.date ?? row.date,
          payee: row.payeeRaw,
        })}
      </Text>

      <EditorPicker
        label={t('Transfer target')}
        suggestions={targets}
        initialText={targetName}
        // A transfer target is an account the budget already has. The
        // import cannot create an account, so a name that matches
        // nothing is refused.
        allowNew={false}
        testId="import-review-transfer-target"
        errorText={t('No account matches that name')}
        onPick={suggestion => {
          setTargetId(suggestion?.id);
        }}
      />

      <View
        style={{
          flexDirection: 'row',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        {/*
          The button shows when the row HAS a transfer: the user's own
          choice, or the resolver's auto-detect.

          It acts on the ROW, not on the draft: it takes the transfer
          away entirely, and any target the user had typed but not saved
          is discarded with it. That is what "remove the transfer" means,
          and the alternative — saving the draft as well — would make the
          button do the opposite of what it says.

          KNOWN LIMIT: a transaction in the budget that is a transfer
          but whose vendor string does not match an account name is
          not something the review can recognise as one, so there is
          nothing to remove here. The user can still point the row at
          another account.
        */}
        {currentTargetId !== undefined ? (
          <Button
            variant="normal"
            onPress={removeTransfer}
            data-testid="import-review-transfer-remove"
          >
            <Trans>Remove transfer</Trans>
          </Button>
        ) : null}

        <View style={{ flex: 1 }} />

        <Button
          variant="primary"
          onPress={commit}
          isDisabled={targetId === undefined}
          data-testid="import-review-transfer-save"
        >
          <Trans>Save transfer</Trans>
        </Button>
      </View>

      <Text style={{ color: theme.pageTextSubdued }}>
        <Trans>Ctrl+Enter to save · Escape to cancel</Trans>
      </Text>
    </View>
  );
}
