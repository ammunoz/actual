/**
 * The pane that routes the rows to another account.
 *
 * A bank file can hold more than one account's transactions, and Actual's
 * OFX parser flattens every statement into one list and drops the bank's
 * account id, so the review cannot tell the statements apart. The user
 * says which rows belong to which account: they put the cursor on a row,
 * pick an account, and the rows from there to the next heading go into it.
 *
 * The pane shows which rows the choice covers, because the answer is not
 * obvious: it is the rows under the cursor up to the next heading, and
 * not every row after it.
 *
 * The account list is the budget's own accounts, minus the closed ones:
 * a closed account is not somewhere transactions are imported into.
 */

import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type { ReviewAccount } from '@actual-app/core/server/transactions/import/review/index';

import { EditorPicker } from './EditorPicker';

export type RoutePaneProps = {
  /**
   * What the choice applies to.
   *
   * `row` — the rows from the cursor to the next heading.
   * `all` — every row.
   */
  scope: 'row' | 'all';
  /** The budget's accounts. */
  accounts: readonly ReviewAccount[];
  /** The account the rows are in now. */
  currentAccountId: string;
  /**
   * The rows the choice covers, numbered from one.
   *
   * The pane covers the table, so the user cannot see which rows are
   * about to move while the pane is open.
   */
  from?: number;
  to?: number;
  /** Commit the choice. */
  onCommit: (accountId: string) => void;
};

export function RoutePane({
  scope,
  accounts,
  currentAccountId,
  from,
  to,
  onCommit,
}: RoutePaneProps) {
  const { t } = useTranslation();

  // A pick that is not an account: the field was cleared. There is
  // nothing to route into, and saying so is better than a keypress that
  // does nothing.
  const [refused, setRefused] = useState(false);

  const suggestions = useMemo(
    () =>
      accounts
        .filter(account => !account.closed)
        .map(account => ({ id: account.id, name: account.name })),
    [accounts],
  );

  const currentName =
    accounts.find(account => account.id === currentAccountId)?.name ?? '';

  return (
    <View
      data-testid="import-review-route"
      style={{
        gap: 8,
        padding: 8,
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 6,
      }}
    >
      <Text>
        {scope === 'row' && from !== undefined && to !== undefined
          ? t('Rows {{from}}–{{to}} go into:', { from, to })
          : t('Every row goes into:')}
      </Text>

      <EditorPicker
        label={t('Account')}
        suggestions={suggestions}
        initialText={currentName}
        // The account the rows are in now, by id: two accounts can have
        // the same name.
        initialSuggestionId={currentAccountId}
        // The account has to be one the budget already has: the import
        // cannot create an account, so a name that matches nothing is
        // refused.
        allowNew={false}
        testId="import-review-route-account"
        errorText={t('No account matches that name')}
        onPick={suggestion => {
          if (!suggestion) {
            setRefused(true);
            return;
          }
          setRefused(false);
          onCommit(suggestion.id);
        }}
      />

      {refused ? (
        <Text style={{ color: theme.warningText }}>
          <Trans>Pick an account to move the rows into</Trans>
        </Text>
      ) : null}
    </View>
  );
}
