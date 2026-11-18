import type { ReactNode } from 'react';

import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';

export type ZoneLabelProps = {
  children: ReactNode;
};

/**
 * The name of a zone in the detail section.
 *
 * The zones are the detail section's structure: the facts, the reason,
 * the ownership and the actions. The label says which is which, so the
 * section can be scanned.
 */
export function ZoneLabel({ children }: ZoneLabelProps) {
  return (
    <Text
      style={{
        color: theme.pageTextSubdued,
        fontWeight: 500,
        fontSize: 12,
      }}
    >
      {children}
    </Text>
  );
}
