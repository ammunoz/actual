import type { ReactNode } from 'react';

import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';

export type ZoneLabelProps = {
  children: ReactNode;
};

/**
 * The name of a zone in the detail section.
 *
 * The zones are the detail section's structure: the row's facts, its
 * review status, its rules and the actions. The label says which is
 * which, so the section can be scanned.
 */
export function ZoneLabel({ children }: ZoneLabelProps) {
  return (
    <Text
      style={{
        color: theme.tableHeaderText,
        fontWeight: 500,
        fontSize: 12,
      }}
    >
      {children}
    </Text>
  );
}

export type ZoneSubheadProps = {
  children: ReactNode;
};

/**
 * A grouping line inside a zone — "From the bank" / "In your budget".
 *
 * It is quieter than the zone label: the zone name says WHERE you are, the
 * subhead says which SIDE of the import these facts come from. The table
 * header token gives it the weight of a column label without competing
 * with the zone's own heading.
 */
export function ZoneSubhead({ children }: ZoneSubheadProps) {
  return (
    <Text
      style={{
        color: theme.tableHeaderText,
        fontWeight: 500,
        fontSize: 11,
      }}
    >
      {children}
    </Text>
  );
}
