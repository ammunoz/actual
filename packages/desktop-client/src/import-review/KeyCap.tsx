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
      style={{
        fontSize: 11,
        lineHeight: 1.5,
        padding: '0 4px',
        marginLeft: 4,
        borderRadius: 3,
        // The edge is what makes the cap a cap, so it is NOT faded: a
        // faded border is not a border. The LABEL is what carries the
        // meaning, and it keeps the colour it inherits — the button's own,
        // which is the full ink.
        border: `1px solid ${theme.pageTextSubdued}`,
        backgroundColor: theme.tableHeaderBackground,
      }}
    >
      {children}
    </Text>
  );
}
