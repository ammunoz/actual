import { useMemo, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import {
  addLeg,
  effectiveAmountCents,
  effectiveTransferAccountId,
  MAX_SPLIT_LEGS,
  seedSplit,
  validateSplit,
  withSplit,
} from '@actual-app/core/server/transactions/import/review/index';
import type {
  PreviewEdits,
  PreviewRow,
  PreviewSplitLeg,
  ReviewCategory,
  SplitErrorCode,
} from '@actual-app/core/server/transactions/import/review/index';
import { integerToAmount } from '@actual-app/core/shared/util';

import { FinancialText } from '#components/FinancialText';

import { parseAmountText } from './editor-mode';
import { EditorPicker } from './EditorPicker';
import { splitErrorMessage } from './split-error-labels';
import { distributeResidual, legAmountText, splitResidual } from './split-mode';
import { TextField } from './TextField';

export type SplitPaneProps = {
  /** The row being split. */
  row: PreviewRow;
  /** The budget's categories. */
  categories: readonly ReviewCategory[];
  /**
   * Commit the split.
   *
   * The pane hands over the WHOLE edits object, not just the split:
   * `updateEdits` replaces a row's edits wholesale, so a commit that
   * carried only the split would throw away the payee, the notes and
   * the date the user had already set.
   */
  onCommit: (edits: PreviewEdits) => void;
};

/**
 * The next id for a draft leg.
 *
 * A module-level counter, not a ref: a ref would be mutated during the
 * render, which is not what refs are for.
 */
let legCounter = 0;
function nextLegId(): string {
  legCounter += 1;
  return `split-leg-${legCounter}`;
}

/**
 * A leg of the draft.
 *
 * The domain's leg type carries no id, and a leg needs one: removing a
 * leg from the middle must not shuffle the fields of the legs around it.
 * The id is the PANE's own and never leaves it — the commit sends the
 * domain's leg type.
 */
type DraftLeg = {
  id: string;
  leg: PreviewSplitLeg;
};

/**
 * The split editor: the legs of the focused row.
 *
 * The pane sits BELOW the table, like the field editor and the help
 * overlay, and it is a MODAL surface: the review's own bindings are
 * switched off while it is open, so the row cursor cannot move out from
 * under it. That is what makes Escape a reliable "discard".
 *
 * It is a FORM, not a hotkey surface. Every action is a control the
 * user can see: the amount and the category of each leg are fields, and
 * adding, removing, distributing and saving are buttons. The keyboard
 * walks the form in the ordinary way — Tab from field to field, Enter to
 * confirm a field — and Ctrl+Enter saves the split from anywhere,
 * including from inside a field, where the plain Enter belongs to the
 * field.
 */
export function SplitPane({ row, categories, onCommit }: SplitPaneProps) {
  const { t } = useTranslation();

  // The amount the legs have to add up to: the row's EFFECTIVE amount,
  // which is what the row would be imported with.
  const target = effectiveAmountCents(row);

  // The draft. It lives here, in the pane, and not in the review's
  // state: an uncommitted split is not work the user would miss, and
  // the review must not be able to hold a half-finished split.
  //
  // An existing split opens AS-IS, so `s` is also the re-edit path. A
  // fresh one starts as two balanced legs carrying the row's own
  // category, so the remaining work is only "give each leg its own
  // category".
  const [legs, setLegs] = useState<DraftLeg[]>(() => {
    const source =
      row.edits.splits ??
      seedSplit(target, row.edits.categoryId ?? row.matchedCategoryId);
    return source.map(leg => ({ id: nextLegId(), leg }));
  });

  // The problem that stops the split from being saved, if there is one.
  const [problem, setProblem] = useState<SplitErrorCode | null>(null);

  const domainLegs = legs.map(draft => draft.leg);
  const residual = splitResidual(domainLegs, target);

  const categorySuggestions = categories.map(category => ({
    id: category.id,
    name: category.name,
    groupName: category.groupName,
  }));

  // The categories, looked up once: a leg finds its category by id, and
  // a table of twenty legs would otherwise search the list twenty
  // times on every render.
  const categoryNames = useMemo(
    () => new Map(categories.map(category => [category.id, category.name])),
    [categories],
  );

  const liveCategoryIds = useMemo(
    () => new Set(categories.map(category => category.id)),
    [categories],
  );

  const setLegAmount = (id: string, cents: number) => {
    setLegs(current =>
      current.map(draft =>
        draft.id === id
          ? { ...draft, leg: { ...draft.leg, amountCents: cents } }
          : draft,
      ),
    );
  };

  const setLegCategory = (id: string, categoryId: string | undefined) => {
    setLegs(current =>
      current.map(draft =>
        draft.id === id
          ? { ...draft, leg: { ...draft.leg, categoryId } }
          : draft,
      ),
    );
  };

  const removeLeg = (id: string) => {
    setLegs(current => {
      // One leg is the floor: a one-leg split is not a split (see
      // `PreviewEdits.splits`), and the button is disabled there anyway.
      if (current.length <= 1) return current;
      return current.filter(draft => draft.id !== id);
    });
  };

  const addAnotherLeg = () => {
    setLegs(current => {
      const source = current.map(draft => draft.leg);
      const added = addLeg(source, splitResidual(source, target).cents);
      if (added.length === source.length) return current;
      return [...current, { id: nextLegId(), leg: added[added.length - 1] }];
    });
  };

  const distribute = () => {
    setLegs(current => {
      const distributed = distributeResidual(
        current.map(draft => draft.leg),
        target,
      );
      return current.map((draft, index) => ({
        ...draft,
        leg: distributed[index],
      }));
    });
  };

  const commit = () => {
    const source = legs.map(draft => draft.leg);

    // The transfer rule is checked here as well as at the apply step: a
    // row is EITHER a transfer OR a split, and the user is better served
    // by being told now than by an import that stops.
    if (effectiveTransferAccountId(row) !== undefined) {
      setProblem('SPLIT-006');
      return;
    }

    // One leg is not a split, and a one-leg split is not a state worth
    // expressing (see `PreviewEdits.splits`). So this is the
    // NORMALISATION path: the row goes back to being an ordinary
    // transaction, keeping the category it had of its own.
    //
    // The Remove button is disabled at one leg, so this is only reached
    // from a stored split that has one leg — which the domain says
    // cannot exist, but which a restored session could still hold.
    if (source.length < 2) {
      onCommit(withSplit(row.edits, undefined));
      return;
    }

    // A leg whose category no longer exists is a leg with NO category:
    // the apply step drops the id, and the leg would land uncategorized
    // without saying so.
    const uncategorized = source.filter(
      leg => !leg.categoryId || !liveCategoryIds.has(leg.categoryId),
    );
    if (uncategorized.length > 0) {
      setProblem('SPLIT-005');
      return;
    }

    // The legs are checked against the row's effective amount by the
    // SAME function the apply step runs for the shape of a split, so the
    // preview cannot author a split the apply step would reject.
    const failure = validateSplit(source, target);
    if (failure) {
      setProblem(failure.code);
      return;
    }

    setProblem(null);
    onCommit(withSplit(row.edits, source));
  };

  const removeSplit = () => {
    onCommit(withSplit(row.edits, undefined));
  };

  // Ctrl+Enter saves the split from anywhere, including from inside a
  // field — where the plain Enter belongs to the field.
  //
  // The pane owns the keyboard while it is open: the review's own
  // bindings are switched off, and the app's are too, because the modal
  // disables the `app` scope. So this key is free.
  useHotkeys(
    'ctrl+enter',
    () => {
      commit();
    },
    { enableOnFormTags: true },
  );

  return (
    <View
      data-testid="import-review-split"
      style={{
        gap: 8,
        padding: 8,
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 6,
      }}
    >
      <Text>
        {t('Splitting {{date}} — {{payee}}', {
          date: row.edits.date ?? row.date,
          payee: row.payeeRaw,
        })}
      </Text>

      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        <Text style={{ color: theme.pageTextSubdued }}>
          <Trans>The legs must add up to</Trans>
        </Text>
        <FinancialText>{integerToAmount(target).toFixed(2)}</FinancialText>
      </View>

      {legs.map((draft, index) => {
        const leg = draft.leg;
        const categoryName = leg.categoryId
          ? (categoryNames.get(leg.categoryId) ?? '')
          : '';

        return (
          <View
            key={draft.id}
            data-testid="import-review-split-leg"
            style={{
              gap: 4,
              padding: 6,
              border: `1px solid ${theme.tableBorder}`,
              borderRadius: 4,
            }}
          >
            <Text style={{ color: theme.pageTextSubdued }}>
              {t('Leg {{number}}', { number: index + 1 })}
            </Text>

            <View
              style={{
                flexDirection: 'row',
                gap: 8,
                alignItems: 'flex-end',
              }}
            >
              <View style={{ width: 150 }}>
                <TextField
                  label={t('Amount')}
                  initialText={legAmountText(leg.amountCents)}
                  autoFocus={index === 0}
                  testId={`import-review-split-leg-amount-${index}`}
                  errorText={t('Enter an amount like -25.00')}
                  isValid={text => parseAmountText(text) !== null}
                  onCommit={text => {
                    const cents = parseAmountText(text);
                    if (cents === null) return;
                    setLegAmount(draft.id, cents);
                  }}
                />
              </View>

              <View style={{ flex: 1 }}>
                <EditorPicker
                  label={t('Category')}
                  suggestions={categorySuggestions}
                  initialText={categoryName}
                  // The leg's own category, by id: two categories can
                  // have the same name in different groups, and pointing
                  // at the first name that matches would commit the
                  // wrong one.
                  initialSuggestionId={leg.categoryId}
                  allowNew={false}
                  // The pane has a picker per leg, and they all mount at
                  // once: only the focused one may claim the focus, or
                  // the last one to mount would win.
                  autoFocus={false}
                  testId={`import-review-split-leg-category-${index}`}
                  errorText={t('No category matches that name')}
                  onPick={suggestion => {
                    // `undefined`, not an empty string: the empty string
                    // is the domain's "cleared" marker, and a leg with
                    // one has no category.
                    setLegCategory(draft.id, suggestion?.id);
                  }}
                />
              </View>

              <Button
                variant="bare"
                isDisabled={legs.length <= 1}
                onPress={() => removeLeg(draft.id)}
                data-testid={`import-review-split-leg-remove-${index}`}
              >
                <Trans>Remove</Trans>
              </Button>
            </View>
          </View>
        );
      })}

      <View
        data-testid="import-review-split-residual"
        style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}
      >
        {residual.direction === 'balanced' ? (
          <Text>
            <Trans>The legs add up to the row amount</Trans>
          </Text>
        ) : (
          <>
            <Text>
              {residual.direction === 'unallocated' ? (
                <Trans>Unallocated</Trans>
              ) : (
                <Trans>Over-allocated</Trans>
              )}
            </Text>
            <FinancialText>
              {integerToAmount(Math.abs(residual.cents)).toFixed(2)}
            </FinancialText>
          </>
        )}
      </View>

      {problem ? (
        <Text
          data-testid="import-review-split-problem"
          style={{ color: theme.errorText }}
        >
          {splitErrorMessage(problem, t)}
        </Text>
      ) : null}

      <View
        style={{
          flexDirection: 'row',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <Button
          variant="normal"
          onPress={addAnotherLeg}
          isDisabled={legs.length >= MAX_SPLIT_LEGS}
          data-testid="import-review-split-add"
        >
          <Trans>Add leg</Trans>
        </Button>
        <Button
          variant="normal"
          onPress={distribute}
          isDisabled={residual.direction === 'balanced'}
          data-testid="import-review-split-distribute"
        >
          <Trans>Distribute</Trans>
        </Button>
        {row.edits.splits !== undefined ? (
          <Button
            variant="normal"
            onPress={removeSplit}
            data-testid="import-review-split-remove"
          >
            <Trans>Remove split</Trans>
          </Button>
        ) : null}

        <View style={{ flex: 1 }} />

        <Button
          variant="primary"
          onPress={commit}
          data-testid="import-review-split-save"
        >
          <Trans>Save split</Trans>
        </Button>
      </View>

      <Text style={{ color: theme.pageTextSubdued }}>
        <Trans>Ctrl+Enter to save · Escape to cancel</Trans>
      </Text>
    </View>
  );
}
