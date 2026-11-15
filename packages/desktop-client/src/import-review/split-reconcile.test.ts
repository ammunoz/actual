import type { TransactionEntity } from '@actual-app/core/types/models';
import { describe, expect, it } from 'vitest';

import { buildSplitReconciliation, childrenOf } from './split-reconcile';

function parent(overrides: Partial<TransactionEntity> = {}): TransactionEntity {
  return {
    id: 'txn-1',
    account: 'a-1',
    date: '2026-09-07',
    amount: -2500,
    payee: 'p-1',
    ...overrides,
  };
}

function child(overrides: Partial<TransactionEntity> = {}): TransactionEntity {
  return {
    id: 'child-1',
    account: 'a-1',
    date: '2026-09-07',
    amount: -1000,
    category: 'c-1',
    is_child: true,
    parent_id: 'txn-1',
    sort_order: -1,
    ...overrides,
  };
}

describe('buildSplitReconciliation', () => {
  it('creates the legs of a transaction that is not a split yet', () => {
    const reconciliation = buildSplitReconciliation({
      parent: parent(),
      children: [],
      legs: [
        { amountCents: -1500, categoryId: 'c-1' },
        { amountCents: -1000, categoryId: 'c-2' },
      ],
    });

    expect(reconciliation.added).toHaveLength(2);
    expect(reconciliation.added[0]).toEqual(
      expect.objectContaining({
        amount: -1500,
        category: 'c-1',
        account: 'a-1',
        date: '2026-09-07',
        is_child: true,
        parent_id: 'txn-1',
      }),
    );
    expect(reconciliation.deleted).toEqual([]);
  });

  it('turns the transaction into a split', () => {
    const reconciliation = buildSplitReconciliation({
      parent: parent({ category: 'c-old' }),
      children: [],
      legs: [{ amountCents: -2500, categoryId: 'c-1' }],
    });

    // A split's parent has no category of its own: the legs carry them.
    expect(reconciliation.updated).toContainEqual(
      expect.objectContaining({
        id: 'txn-1',
        is_parent: true,
        category: null,
        amount: -2500,
      }),
    );
  });

  it('updates the legs that are already there, in order', () => {
    // The legs are matched in order, so a leg that is already there keeps
    // its id — and anything the user put on it survives.
    const reconciliation = buildSplitReconciliation({
      parent: parent(),
      children: [child({ id: 'child-1' }), child({ id: 'child-2' })],
      legs: [
        { amountCents: -2000, categoryId: 'c-1' },
        { amountCents: -500, categoryId: 'c-2' },
      ],
    });

    expect(reconciliation.added).toEqual([]);
    expect(reconciliation.deleted).toEqual([]);
    expect(reconciliation.updated).toContainEqual(
      expect.objectContaining({
        id: 'child-1',
        amount: -2000,
        category: 'c-1',
      }),
    );
    expect(reconciliation.updated).toContainEqual(
      expect.objectContaining({ id: 'child-2', amount: -500, category: 'c-2' }),
    );
  });

  it('deletes the legs that are gone', () => {
    const reconciliation = buildSplitReconciliation({
      parent: parent(),
      children: [child({ id: 'child-1' }), child({ id: 'child-2' })],
      legs: [{ amountCents: -2500, categoryId: 'c-1' }],
    });

    expect(reconciliation.deleted).toEqual([{ id: 'child-2' }]);
  });

  it('adds the legs that are new', () => {
    const reconciliation = buildSplitReconciliation({
      parent: parent(),
      children: [child({ id: 'child-1' })],
      legs: [
        { amountCents: -1500, categoryId: 'c-1' },
        { amountCents: -1000, categoryId: 'c-2' },
      ],
    });

    expect(reconciliation.added).toHaveLength(1);
    expect(reconciliation.added[0]).toEqual(
      expect.objectContaining({ amount: -1000, category: 'c-2' }),
    );
  });

  it('says outright that a leg has no category', () => {
    // Upstream's `makeChild` decides inherit-vs-override with
    // `"category" in data`, so leaving the key out would make the leg
    // inherit the parent's category.
    const reconciliation = buildSplitReconciliation({
      parent: parent({ category: 'c-parent' }),
      children: [],
      legs: [{ amountCents: -2500 }],
    });

    expect(reconciliation.added[0]).toEqual(
      expect.objectContaining({ category: null }),
    );
  });

  it('the parent adds up to the legs', () => {
    const reconciliation = buildSplitReconciliation({
      parent: parent(),
      children: [],
      legs: [
        { amountCents: -1500, categoryId: 'c-1' },
        { amountCents: -1000, categoryId: 'c-2' },
      ],
    });

    expect(reconciliation.updated).toContainEqual(
      expect.objectContaining({ id: 'txn-1', amount: -2500 }),
    );
  });

  it('clears the error of a parent whose legs did not add up', () => {
    const reconciliation = buildSplitReconciliation({
      parent: parent({
        error: { type: 'SplitTransactionError', version: 1, difference: -100 },
      }),
      children: [],
      legs: [{ amountCents: -2500, categoryId: 'c-1' }],
    });

    expect(reconciliation.updated).toContainEqual(
      expect.objectContaining({ id: 'txn-1', error: null }),
    );
  });
});

describe('childrenOf', () => {
  it('finds the legs of a transaction', () => {
    const transactions = [
      parent(),
      child({ id: 'child-1' }),
      child({ id: 'child-2', parent_id: 'txn-other' }),
    ];

    expect(childrenOf(transactions, 'txn-1').map(t => t.id)).toEqual([
      'child-1',
    ]);
  });
});
