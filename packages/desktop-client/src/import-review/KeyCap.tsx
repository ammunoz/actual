import type { ReactNode } from 'react';

import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';

export type KeyCapProps = {
  /** The key, as the user writes it: `⇧A`, `Ctrl+S`, `?`. */
  children: ReactNode;
};

/**
 * A key, shown as a key.
 *
 * The review is driven from the keyboard, so the key that does a thing
 * belongs NEXT TO the thing — not only in the `?` overlay, which the
 * user has to know to open.
 *
 * The cap is a little smaller than the label it follows, and it sits in
 * a box, so the label still reads first.
 */
export function KeyCap({ children }: KeyCapProps) {
  return (
    <Text
      // The cap OWNS its colours — the fill AND the ink.
      //
      // It used to take its ink from whatever it sat in, which was right
      // on a white surface and wrong on the primary button: the button's
      // white text over the cap's own white fill made "Ctrl+S" white on
      // white, and unreadable. A cap that owns both cannot be broken by
      // the surface it lands on.
      //
      // The pair is the app's own: the table's header surface and the
      // page's ink, which read against each other in every theme — white
      // on near-black in the light theme, and the reverse of a dark
      // surface in the others.
      data-testid="key-cap"
      // A key cap is a visual affordance. It must not change the button's
      // accessible name: "Import" stays "Import" for a screen reader and
      // for every test that finds the button by its name.
      aria-hidden
      style={{
        fontSize: 11,
        lineHeight: 1.5,
        padding: '0 4px',
        marginLeft: 4,
        borderRadius: 3,
        // The edge is what makes the cap a cap, so it is NOT faded: a
        // faded border is not a border.
        border: `1px solid ${theme.pageTextSubdued}`,
        backgroundColor: theme.tableHeaderBackground,
        color: theme.pageText,
      }}
    >
      {children}
    </Text>
  );
}
