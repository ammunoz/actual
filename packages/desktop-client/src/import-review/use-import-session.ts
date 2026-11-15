/**
 * Where the saved review lives.
 *
 * The store is the browser's own `localStorage`, scoped to the budget the
 * way upstream's local preferences are scoped (`useLocalPref`): the key
 * carries the budget id, so one budget's review is never shown in
 * another's.
 *
 * It is NOT a synced preference. A review in progress belongs to the
 * machine it was made on, and a synced preference would push the whole
 * blob through the CRDT on every save — and the blob is not small.
 */

import { useCallback, useEffect, useState } from 'react';

import { useMetadataPref } from '#hooks/useMetadataPref';

import type { ImportReviewSession } from './session';
import { readSession, writeSession } from './session';

/**
 * The key the session is stored under, within the budget.
 */
export const SESSION_KEY = 'import-review.session';

export type UseImportSession = {
  /** The saved review, if there is one. */
  session: ImportReviewSession | undefined;
  /** Save a review. Returns false when it does not fit. */
  save: (session: ImportReviewSession) => boolean;
  /** Throw the saved review away. */
  clear: () => void;
};

/**
 * The store for the saved review.
 */
export function useImportSession(): UseImportSession {
  const [budgetId] = useMetadataPref('id');
  const [session, setSession] = useState<ImportReviewSession | undefined>(
    undefined,
  );

  // The saved review is read once, when the store is first used. It is
  // not read again: the review that saves one is the one that reads it,
  // and a review in progress is not disturbed by what is on disk.
  useEffect(() => {
    if (!budgetId) return;
    try {
      const stored = window.localStorage.getItem(storageKey(budgetId));
      setSession(readSession(stored));
    } catch {
      // A browser that will not give up its storage is a browser that
      // cannot save a review either. There is nothing to say about it.
      setSession(undefined);
    }
  }, [budgetId]);

  const save = useCallback(
    (next: ImportReviewSession) => {
      if (!budgetId) return false;
      try {
        window.localStorage.setItem(storageKey(budgetId), writeSession(next));
      } catch {
        // The storage is full, or the browser will not write to it. The
        // review says so rather than pretending it was saved.
        return false;
      }
      setSession(next);
      return true;
    },
    [budgetId],
  );

  const clear = useCallback(() => {
    if (!budgetId) return;
    try {
      window.localStorage.removeItem(storageKey(budgetId));
    } catch {
      // Nothing to do: the session is gone either way if it cannot be
      // removed.
    }
    setSession(undefined);
  }, [budgetId]);

  return { session, save, clear };
}

/**
 * Pure: where a budget's session is stored.
 */
export function storageKey(budgetId: string): string {
  return `${budgetId}-${SESSION_KEY}`;
}
