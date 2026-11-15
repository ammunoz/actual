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
 * The event the store tells the world about when the session changes.
 *
 * The command bar is mounted for the whole life of the app, so it read
 * the session when the app started — long before the user saved a
 * review. The event is how it hears about one.
 */
const SESSION_CHANGED = 'import-review-session-changed';

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

  // The saved review is read when the store is first used, and again
  // whenever it changes: the command bar is mounted for the whole life
  // of the app, so it read the session long before the user saved a
  // review.
  useEffect(() => {
    if (!budgetId) return;

    const read = () => {
      try {
        const stored = window.localStorage.getItem(storageKey(budgetId));
        setSession(readSession(stored));
      } catch {
        // A browser that will not give up its storage is a browser that
        // cannot save a review either. There is nothing to say about it.
        setSession(undefined);
      }
    };

    read();
    window.addEventListener(SESSION_CHANGED, read);
    return () => window.removeEventListener(SESSION_CHANGED, read);
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
      window.dispatchEvent(new Event(SESSION_CHANGED));
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
    window.dispatchEvent(new Event(SESSION_CHANGED));
  }, [budgetId]);

  return { session, save, clear };
}

/**
 * Pure: where a budget's session is stored.
 */
export function storageKey(budgetId: string): string {
  return `${budgetId}-${SESSION_KEY}`;
}
