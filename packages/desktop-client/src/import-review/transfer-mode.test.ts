import type {
  ReviewAccount,
  ReviewPayee,
} from '@actual-app/core/server/transactions/import/review/index';

import { transferTargets } from './transfer-mode';

function mkAccount(
  id: string,
  name: string,
  overrides: Partial<ReviewAccount> = {},
): ReviewAccount {
  return { id, name, ...overrides };
}

function mkPayee(id: string, name: string, transferAcct?: string): ReviewPayee {
  return { id, name, ...(transferAcct !== undefined && { transferAcct }) };
}

describe('transferTargets', () => {
  it('offers the accounts that have a transfer payee', () => {
    const targets = transferTargets(
      [mkAccount('a-1', 'Checking'), mkAccount('a-2', 'Savings')],
      [mkPayee('p-1', 'Savings', 'a-2')],
      'a-1',
    );
    expect(targets).toEqual([{ id: 'a-2', name: 'Savings' }]);
  });

  it('leaves out an account with no transfer payee', () => {
    // The import needs the account's hidden transfer payee to send a
    // transfer. Without one the row would land as an ordinary
    // transaction, with nothing saying so.
    const targets = transferTargets(
      [mkAccount('a-1', 'Checking'), mkAccount('a-2', 'Savings')],
      [mkPayee('p-1', 'An ordinary payee')],
      'a-1',
    );
    expect(targets).toEqual([]);
  });

  it('leaves out the account the import is going into', () => {
    // A transfer to itself is not a transfer.
    const targets = transferTargets(
      [mkAccount('a-1', 'Checking')],
      [mkPayee('p-1', 'Checking', 'a-1')],
      'a-1',
    );
    expect(targets).toEqual([]);
  });

  it('leaves out a closed account', () => {
    const targets = transferTargets(
      [mkAccount('a-1', 'Checking'), mkAccount('a-2', 'Old', { closed: true })],
      [mkPayee('p-1', 'Old', 'a-2')],
      'a-1',
    );
    expect(targets).toEqual([]);
  });

  it('keeps the accounts own order', () => {
    const targets = transferTargets(
      [mkAccount('a-1', 'Checking'), mkAccount('a-2', 'Savings')],
      [mkPayee('p-1', 'Savings', 'a-2'), mkPayee('p-2', 'Checking', 'a-1')],
      'a-1',
    );
    expect(targets).toEqual([{ id: 'a-2', name: 'Savings' }]);
  });

  it('offers an off-budget account', () => {
    // Moving money out of the budget is a transfer too: upstream keeps
    // the category on a transfer that crosses the budget boundary, and
    // that is the budget's business, not the picker's.
    const targets = transferTargets(
      [
        mkAccount('a-1', 'Checking'),
        mkAccount('a-2', 'Broker', { offbudget: true }),
      ],
      [mkPayee('p-1', 'Broker', 'a-2')],
      'a-1',
    );
    expect(targets).toEqual([{ id: 'a-2', name: 'Broker' }]);
  });

  it('offers an account whose payee is the only thing that names it', () => {
    // A transfer payee's NAME is the account's name: the budget stores
    // the payee with an empty name and reads the account's.
    const targets = transferTargets(
      [mkAccount('a-2', 'Savings')],
      [mkPayee('p-1', '', 'a-2')],
      'a-1',
    );
    expect(targets).toEqual([{ id: 'a-2', name: 'Savings' }]);
  });
});
