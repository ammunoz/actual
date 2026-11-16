import type { ReviewPayee } from '#server/transactions/import/review/types';

import {
  buildFuzzyCache,
  fingerprintPayees,
  fuzzyCacheKey,
} from './payee-cache';

function payee(
  id: string,
  name: string,
  transferAcct?: string | null,
): ReviewPayee {
  return { id, name, transferAcct };
}

describe('the fuzzy cache', () => {
  it('returns what was set, and undefined for an unknown key', () => {
    const cache = buildFuzzyCache();
    expect(cache.get('fp', 'nothing')).toBeUndefined();

    const matches = [
      { candidate: { id: 'p1', name: 'Demo Coffee' }, score: 0.9 },
    ];
    cache.set('fp', 'a-key', matches);
    expect(cache.get('fp', 'a-key')).toEqual(matches);
  });

  it('does not serve one payee list entries to another', () => {
    // The fingerprint is the cache's outer level, so two lists never
    // see each other's answers.
    const cache = buildFuzzyCache();
    cache.set('fp-one', 'a-key', [
      { candidate: { id: 'p1', name: 'One' }, score: 0.9 },
    ]);
    expect(cache.get('fp-two', 'a-key')).toBeUndefined();
  });

  it('clear() empties it', () => {
    const cache = buildFuzzyCache();
    cache.set('fp', 'a-key', []);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('fp', 'a-key')).toBeUndefined();
  });

  it('is a fresh cache each time, so two budgets never share one', () => {
    const first = buildFuzzyCache();
    const second = buildFuzzyCache();
    first.set('fp', 'a-key', []);
    expect(second.size).toBe(0);
  });
});

describe('fingerprintPayees', () => {
  it('is stable across reordering', () => {
    // The resolver's index sorts by name length anyway, so the payee
    // list's order must not change the fingerprint.
    const a = payee('p1', 'Alpha');
    const b = payee('p2', 'Beta');
    expect(fingerprintPayees([a, b])).toBe(fingerprintPayees([b, a]));
  });

  it('changes when a payee is renamed, added, or removed', () => {
    const base = [payee('p1', 'Alpha'), payee('p2', 'Beta')];
    const fingerprint = fingerprintPayees(base);

    expect(
      fingerprintPayees([payee('p1', 'Alpha Renamed'), payee('p2', 'Beta')]),
    ).not.toBe(fingerprint);
    expect(fingerprintPayees([...base, payee('p3', 'Gamma')])).not.toBe(
      fingerprint,
    );
    expect(fingerprintPayees([payee('p1', 'Alpha')])).not.toBe(fingerprint);
  });

  it('changes when a payee becomes a transfer', () => {
    // The resolver's index EXCLUDES transfer payees from the candidate
    // list, so a payee that becomes a transfer leaves the candidates
    // and the fuzzy answer changes.
    const plain = fingerprintPayees([payee('p1', 'Alpha')]);
    const transfer = fingerprintPayees([payee('p1', 'Alpha', 'account-1')]);
    expect(transfer).not.toBe(plain);
  });

  it('does not confuse two lists whose names contain the separator', () => {
    // The fingerprint joins its records on a NUL character. Payee names
    // are free text a person typed, so they may contain it — and a naive
    // join would alias these two lists, because the records run
    // together into the same characters.
    const one = fingerprintPayees([
      payee('p1', 'a\u0000b', 'c'),
      payee('p2', 'd', 'e'),
    ]);
    const two = fingerprintPayees([
      payee('p1', 'a', 'b\u0000c'),
      payee('p2', 'd', 'e'),
    ]);
    expect(one).not.toBe(two);
  });

  it('does not confuse two lists whose names contain JSON punctuation', () => {
    // The record is JSON-encoded, so a name containing a quote, a
    // bracket or a comma cannot break out of it.
    const one = fingerprintPayees([payee('p1', 'a","b"]'), payee('p2', 'c')]);
    const two = fingerprintPayees([payee('p1', 'a'), payee('p2', 'b","c')]);
    expect(one).not.toBe(two);
  });

  it('distinguishes a null transfer account from an empty one', () => {
    expect(fingerprintPayees([payee('p1', 'Alpha', null)])).not.toBe(
      fingerprintPayees([payee('p1', 'Alpha', '')]),
    );
  });
});

describe('fuzzyCacheKey', () => {
  it('changes with the raw string and the thresholds', () => {
    const base = fuzzyCacheKey({ minScore: 0.7, maxResults: 5 }, 'RAW');
    expect(base).not.toBe(
      fuzzyCacheKey({ minScore: 0.7, maxResults: 5 }, 'OTHER'),
    );
    expect(base).not.toBe(
      fuzzyCacheKey({ minScore: 0.6, maxResults: 5 }, 'RAW'),
    );
    expect(base).not.toBe(
      fuzzyCacheKey({ minScore: 0.7, maxResults: 3 }, 'RAW'),
    );
  });

  it('is the same for the same inputs', () => {
    expect(fuzzyCacheKey({ minScore: 0.7, maxResults: 5 }, 'RAW')).toBe(
      fuzzyCacheKey({ minScore: 0.7, maxResults: 5 }, 'RAW'),
    );
  });

  it('does not carry the payee list, which is the cache outer level', () => {
    // The fingerprint is a few kilobytes. Putting it in every key
    // would copy it once per row, and on a ten thousand row file that
    // is hundreds of megabytes of key strings for the answers
    // themselves. So the key does not carry it.
    const key = fuzzyCacheKey({ minScore: 0.7, maxResults: 5 }, 'RAW');
    expect(key).not.toContain(fingerprintPayees([payee('p1', 'Alpha')]));
  });

  it('uses the EFFECTIVE thresholds, so the defaults take one entry', () => {
    // The resolver applies its defaults, so a resolve with no thresholds
    // behaves exactly like one with the defaults spelled out. If the key
    // used the raw thresholds, the two would take two different entries
    // for the same answer.
    expect(fuzzyCacheKey(undefined, 'RAW')).toBe(
      fuzzyCacheKey({ minScore: 0.7, maxResults: 5 }, 'RAW'),
    );
  });

  it('does not depend on the rules', () => {
    // The rules do not change the fuzzy layer's answer, so putting them
    // in the key would invalidate the whole cache on every rule write
    // — which is exactly when the cache matters most. The key has no
    // slot for them.
    const key = fuzzyCacheKey({ minScore: 0.7, maxResults: 5 }, 'RAW');
    expect(key).not.toContain('rule');
  });
});
