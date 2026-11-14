/**
 * Access to synced preferences that are ours rather than upstream's.
 *
 * `SyncedPrefs` is a closed union of literal and template-literal keys. It
 * does NOT have a catch-all: `Partial<Record<..., string>>` collapses the
 * key union to the literal members, so `keyof SyncedPrefs` rejects any key
 * that is not already declared upstream.
 *
 * Rather than edit upstream's `packages/loot-core/src/types/prefs.ts` — the
 * one upstream file the whole "no upstream changes" plan is built on — the
 * cast is confined to THIS file. Everything else in the feature uses the
 * typed keys exported from here.
 *
 * The cast is safe at runtime: `saveSyncedPrefs` already sends any key
 * (`id: prefName as keyof SyncedPrefs`) and the `preferences` table is a
 * plain `{id, value}` key-value store that syncs across devices. Only the
 * compile-time key list is restrictive.
 */

import { useCallback } from 'react';

import type { SyncedPrefs } from '@actual-app/core/types/prefs';

import { saveSyncedPrefs } from '#prefs/prefsSlice';
import { useDispatch, useSelector } from '#redux';

/**
 * A synced preference key that is not declared in upstream's `SyncedPrefs`.
 */
export type CustomSyncedPrefKey = string & {};

/**
 * Read and write one synced preference whose key is ours.
 *
 * The key is not constrained by upstream's union, but the VALUE type still
 * is: synced prefs are strings.
 */
export function useCustomSyncedPref(
  prefName: CustomSyncedPrefKey,
): [string | undefined, (value: string) => void] {
  const dispatch = useDispatch();
  const setPref = useCallback(
    (value: string) => {
      void dispatch(
        saveSyncedPrefs({
          prefs: { [prefName]: value } as Partial<SyncedPrefs>,
        }),
      );
    },
    [prefName, dispatch],
  );
  const pref = useSelector(
    (state): string | undefined =>
      (state.prefs.synced as Record<string, string | undefined>)[prefName],
  );

  return [pref, setPref];
}
