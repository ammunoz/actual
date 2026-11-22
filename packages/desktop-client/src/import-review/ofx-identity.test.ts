import {
  OFX_IDENTITY_LAST_N_CAP,
  type AccountRef,
  type IdentityEntry,
  findMismatch,
  readIdentityMap,
  recordAccounts,
  suggestAccount,
} from './ofx-identity';

const OPEN: readonly AccountRef[] = [
  { id: 'checking', name: 'Checking' },
  { id: 'taxes', name: 'Taxes' },
];

describe('readIdentityMap', () => {
  it('is empty for missing or malformed input', () => {
    expect(readIdentityMap(undefined).size).toBe(0);
    expect(readIdentityMap('not json').size).toBe(0);
    expect(readIdentityMap('[]').size).toBe(0);
    expect(readIdentityMap('null').size).toBe(0);
  });

  it('migrates a legacy single-account entry without trusting it', () => {
    const map = readIdentityMap(
      JSON.stringify({
        'BANKID|ACCTID': {
          accountId: 'checking',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
    const entry = map.get('BANKID|ACCTID');
    expect(entry).toEqual({
      accountId: 'checking',
      updatedAt: '2026-01-01T00:00:00.000Z',
      hits: 1,
      lastN: [{ accountId: 'checking', at: '2026-01-01T00:00:00.000Z' }],
    });
    expect(suggestAccount(entry, OPEN)).toBeUndefined();
  });

  it('skips entries with invalid fields', () => {
    const map = readIdentityMap(
      JSON.stringify({
        valid: { accountId: 'checking', updatedAt: '2026-01-01' },
        noAccount: { updatedAt: '2026-01-01' },
        noDate: { accountId: 'checking' },
        nonsense: 5,
      }),
    );
    expect([...map.keys()]).toEqual(['valid']);
  });

  it('ignores negative and non-integer hits and dedupes lastN', () => {
    const map = readIdentityMap(
      JSON.stringify({
        id: {
          accountId: 'checking',
          updatedAt: 'now',
          hits: -5,
          lastN: [
            { accountId: 'checking', at: 't1' },
            { accountId: 'checking', at: 't2' },
            { accountId: 'taxes', at: 't3' },
          ],
        },
      }),
    );
    const entry = map.get('id');
    expect(entry?.hits).toBe(1);
    expect(entry?.lastN.map(item => item.accountId)).toEqual([
      'checking',
      'taxes',
    ]);
  });

  it('handles a __proto__ key safely', () => {
    const map = readIdentityMap(
      '{"__proto__":{"accountId":"checking","updatedAt":"now"}}',
    );
    expect(map.get('__proto__')?.accountId).toBe('checking');
    expect(({} as Record<string, unknown>).accountId).toBeUndefined();
  });

  it('caps lastN at the configured size', () => {
    const lastN = Array.from({ length: 10 }, (_, index) => ({
      accountId: `account-${index}`,
      at: `2026-01-0${index + 1}`,
    }));
    const entry = readIdentityMap(
      JSON.stringify({
        id: { accountId: 'checking', updatedAt: 'now', hits: 5, lastN },
      }),
    ).get('id');
    expect(entry?.lastN).toHaveLength(OFX_IDENTITY_LAST_N_CAP);
  });
});

describe('findMismatch', () => {
  const map = new Map<string, IdentityEntry>([
    [
      'A',
      {
        accountId: 'checking',
        updatedAt: 'now',
        hits: 3,
        lastN: [],
      },
    ],
  ]);

  it('reports a mismatch when the target differs', () => {
    expect(findMismatch(map, ['A'], 'taxes')).toEqual({
      identity: 'A',
      mappedAccountId: 'checking',
    });
  });

  it('reports nothing when accounts match', () => {
    expect(findMismatch(map, ['A'], 'checking')).toBeNull();
  });

  it('reports nothing for unknown or empty identities', () => {
    expect(findMismatch(map, [], 'taxes')).toBeNull();
    expect(findMismatch(map, ['unknown'], 'taxes')).toBeNull();
  });

  it('returns only the first distinct mismatch', () => {
    const two = new Map(map);
    two.set('B', {
      accountId: 'checking',
      updatedAt: 'now',
      hits: 3,
      lastN: [],
    });
    expect(findMismatch(two, ['A', 'B'], 'taxes')).toEqual({
      identity: 'A',
      mappedAccountId: 'checking',
    });
  });
});

describe('recordAccounts', () => {
  it('increments hits for repeated imports into one account', () => {
    const first = recordAccounts(new Map(), ['A'], 'checking', 't1');
    const second = recordAccounts(readIdentityMap(first), ['A'], 'checking', 't2');
    expect(readIdentityMap(second).get('A')?.hits).toBe(2);
  });

  it('resets hits and keeps history on an import into a different account', () => {
    const first = recordAccounts(new Map(), ['A'], 'checking', 't1');
    const second = recordAccounts(readIdentityMap(first), ['A'], 'taxes', 't2');
    const entry = readIdentityMap(second).get('A');
    expect(entry?.accountId).toBe('taxes');
    expect(entry?.hits).toBe(1);
    expect(entry?.lastN.map(item => item.accountId)).toContain('checking');
  });

  it('ignores empty identities and is a no-op for an empty list', () => {
    const empty = recordAccounts(new Map(), [], 'checking', 't1');
    expect(readIdentityMap(empty).size).toBe(0);
    const withEmpty = recordAccounts(new Map(), [''], 'checking', 't1');
    expect(readIdentityMap(withEmpty).size).toBe(0);
  });

  it('does not mutate the input map', () => {
    const original = readIdentityMap(
      JSON.stringify({
        A: { accountId: 'checking', updatedAt: 't1', hits: 3, lastN: [] },
      }),
    );
    recordAccounts(original, ['A'], 'checking', 't2');
    expect(original.get('A')?.updatedAt).toBe('t1');
  });
});

describe('suggestAccount', () => {
  function entry(overrides: Partial<IdentityEntry> = {}): IdentityEntry {
    return {
      accountId: 'checking',
      updatedAt: 't3',
      hits: 3,
      lastN: [{ accountId: 'checking', at: 't3' }],
      ...overrides,
    };
  }

  it('suggests a dominant, still-open account', () => {
    expect(suggestAccount(entry(), OPEN)).toBe('checking');
  });

  it('does not suggest after a single import', () => {
    expect(suggestAccount(entry({ hits: 1 }), OPEN)).toBeUndefined();
  });

  it('does not suggest when a recent import used another account', () => {
    expect(
      suggestAccount(
        entry({ lastN: [{ accountId: 'taxes', at: 't3' }] }),
        OPEN,
      ),
    ).toBeUndefined();
  });

  it('does not suggest a closed or deleted account', () => {
    expect(suggestAccount(entry(), [{ id: 'taxes', name: 'Taxes' }])).toBeUndefined();
    expect(suggestAccount(undefined, OPEN)).toBeUndefined();
  });
});
