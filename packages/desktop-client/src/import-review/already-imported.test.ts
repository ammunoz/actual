import { describe, expect, it, vi } from 'vitest';

import { aqlQuery } from '#queries/aqlQuery';

import {
  findImportedTransactions,
  matchRowsToTransactions,
} from './already-imported';

vi.mock('#queries/aqlQuery', () => ({
  aqlQuery: vi.fn(),
}));

const mockedAqlQuery = vi.mocked(aqlQuery);

describe('findImportedTransactions', () => {
  it('asks for the transactions that carry the FITIDs, in the account', async () => {
    mockedAqlQuery.mockResolvedValue({
      data: [{ id: 'txn-1', imported_id: 'FITID-1' }],
      dependencies: [],
    });

    await findImportedTransactions({
      accountId: 'acct-1',
      importedIds: ['FITID-1'],
    });

    expect(mockedAqlQuery).toHaveBeenCalledTimes(1);
    const query = mockedAqlQuery.mock.calls[0][0];
    expect(query.state.table).toBe('transactions');
    // The account and the FITIDs are ONE filter: the transaction has to be
    // in this account AND carry one of these FITIDs.
    expect(query.state.filterExpressions).toEqual([
      { account: 'acct-1', imported_id: { $oneof: ['FITID-1'] } },
    ]);
  });

  it('asks for nothing when the file supplied no FITIDs', async () => {
    mockedAqlQuery.mockClear();

    const found = await findImportedTransactions({
      accountId: 'acct-1',
      importedIds: [],
    });

    expect(mockedAqlQuery).not.toHaveBeenCalled();
    expect(found.size).toBe(0);
  });

  it('asks once for each distinct FITID', async () => {
    mockedAqlQuery.mockResolvedValue({ data: [], dependencies: [] });

    await findImportedTransactions({
      accountId: 'acct-1',
      importedIds: ['FITID-1', 'FITID-1', 'FITID-2'],
    });

    const query = mockedAqlQuery.mock.calls[0][0];
    expect(query.state.filterExpressions).toEqual([
      { account: 'acct-1', imported_id: { $oneof: ['FITID-1', 'FITID-2'] } },
    ]);
  });

  it('maps each transaction to the FITID that found it', async () => {
    mockedAqlQuery.mockResolvedValue({
      data: [
        { id: 'txn-1', imported_id: 'FITID-1' },
        { id: 'txn-2', imported_id: 'FITID-2' },
      ],
      dependencies: [],
    });

    const found = await findImportedTransactions({
      accountId: 'acct-1',
      importedIds: ['FITID-1', 'FITID-2'],
    });

    expect(found.get('FITID-1')).toBe('txn-1');
    expect(found.get('FITID-2')).toBe('txn-2');
  });

  it('keeps the first transaction when two carry the same FITID', async () => {
    mockedAqlQuery.mockResolvedValue({
      data: [
        { id: 'txn-1', imported_id: 'FITID-1' },
        { id: 'txn-2', imported_id: 'FITID-1' },
      ],
      dependencies: [],
    });

    const found = await findImportedTransactions({
      accountId: 'acct-1',
      importedIds: ['FITID-1'],
    });

    expect(found.get('FITID-1')).toBe('txn-1');
  });

  it('ignores rows that are not transactions', async () => {
    mockedAqlQuery.mockResolvedValue({
      data: [null, 'nonsense', { id: 42, imported_id: 'FITID-1' }],
      dependencies: [],
    });

    const found = await findImportedTransactions({
      accountId: 'acct-1',
      importedIds: ['FITID-1'],
    });

    expect(found.size).toBe(0);
  });
});

describe('matchRowsToTransactions', () => {
  it('matches a row to the transaction its FITID found', () => {
    const matched = matchRowsToTransactions(
      [{ previewKey: 'row-0', importedId: 'FITID-1' }],
      new Map([['FITID-1', 'txn-1']]),
    );

    expect(matched.get('row-0')).toBe('txn-1');
  });

  it('leaves a row alone when its FITID is in no transaction', () => {
    const matched = matchRowsToTransactions(
      [{ previewKey: 'row-0', importedId: 'FITID-1' }],
      new Map(),
    );

    expect(matched.size).toBe(0);
  });

  it('leaves a row alone when it has no FITID', () => {
    const matched = matchRowsToTransactions(
      [{ previewKey: 'row-0' }],
      new Map([['FITID-1', 'txn-1']]),
    );

    expect(matched.size).toBe(0);
  });

  it('leaves an ambiguous FITID alone: two rows would edit one transaction', () => {
    const matched = matchRowsToTransactions(
      [
        { previewKey: 'row-0', importedId: 'SAME' },
        { previewKey: 'row-1', importedId: 'SAME' },
      ],
      new Map([['SAME', 'txn-1']]),
    );

    expect(matched.size).toBe(0);
  });

  it('matches each row to its own transaction', () => {
    const matched = matchRowsToTransactions(
      [
        { previewKey: 'row-0', importedId: 'FITID-1' },
        { previewKey: 'row-1', importedId: 'FITID-2' },
      ],
      new Map([
        ['FITID-1', 'txn-1'],
        ['FITID-2', 'txn-2'],
      ]),
    );

    expect(matched.get('row-0')).toBe('txn-1');
    expect(matched.get('row-1')).toBe('txn-2');
  });
});
