import type { ReactNode } from 'react';

import type { CSSProperties } from '@actual-app/components/styles';
import { View } from '@actual-app/components/view';

/**
 * The review's column template.
 *
 * ONE template, used by the header and by every row, so the two cannot
 * drift apart — the first mockup of the redesign got this wrong and the
 * headers did not line up with the body.
 *
 * **The widths are a budget, not a guess.** The four FIXED columns take
 * 446px in total, plus four 12px gaps. The payee is the only flexible
 * column: it takes whatever is left at the page's current width, with a
 * floor so it is never squeezed to nothing on a narrow window. On the
 * old 900px modal that left the payee about 317–332px; on the full-page
 * review it gets the much wider remainder. Nothing truncates: the only
 * long string in the review, the file's raw vendor string, is not in the
 * list at all. It is evidence, and it lives in the detail section, in
 * full, for the row the user is on.
 *
 * The date and the amount are wide enough for the RULED field as well:
 * a ruled cell carries a tag glyph and the field's padding beside the
 * value, and a column that is too narrow for that would clip the value.
 * A ruled date needs about 97px, which is why the date is 100 and not
 * the 76 a plain date would take. The amount is narrower, and a ruled
 * amount with a great many digits in it truncates to its tooltip — the
 * same as an ordinary amount that does.
 */
export const REVIEW_COLUMNS = {
  date: 100,
  payee: 'flex',
  category: 150,
  amount: 84,
  status: 112,
} as const;

/**
 * The style a column's box carries.
 *
 * The fixed columns do not shrink, so on a narrow viewport the row is
 * wider than the page and the TABLE scrolls — once, with the header on
 * it — rather than every row having its own scrollbar.
 *
 * The flexible column has a floor, so the payee is never squeezed to
 * nothing on a narrow viewport: the table scrolls instead.
 */
export function columnStyle(width: number | 'flex'): CSSProperties {
  return width === 'flex'
    ? { flex: 1, minWidth: 120 }
    : { width, flexShrink: 0 };
}

/**
 * One cell of the review's table.
 */
export type ReviewCell = {
  /** For the test to find. */
  testId?: string;
  /** Whether a rule controls this cell. */
  ruled?: boolean;
  /**
   * The cell's role.
   *
   * The review is a table, and a screen reader is told so: the header's
   * cells are column headers and the rows' cells are cells.
   */
  role?: 'columnheader' | 'cell';
  /** The cell's content. */
  children: ReactNode;
};

/**
 * The review's table, laid out in its columns.
 *
 * The header and every row go through this, which is what makes them
 * line up: there is one set of widths and one set of boxes, and they
 * are the same for all of them.
 */
export function ReviewColumns({
  date,
  payee,
  category,
  amount,
  status,
}: {
  date: ReviewCell;
  payee: ReviewCell;
  category: ReviewCell;
  amount: ReviewCell;
  status: ReviewCell;
}) {
  return (
    <>
      <View
        style={columnStyle(REVIEW_COLUMNS.date)}
        data-testid={date.testId}
        data-ruled={date.ruled ? 'true' : undefined}
        role={date.role}
      >
        {date.children}
      </View>
      <View
        style={columnStyle(REVIEW_COLUMNS.payee)}
        data-testid={payee.testId}
        data-ruled={payee.ruled ? 'true' : undefined}
        role={payee.role}
      >
        {payee.children}
      </View>
      <View
        style={columnStyle(REVIEW_COLUMNS.category)}
        data-testid={category.testId}
        data-ruled={category.ruled ? 'true' : undefined}
        role={category.role}
      >
        {category.children}
      </View>
      <View
        style={columnStyle(REVIEW_COLUMNS.amount)}
        data-testid={amount.testId}
        data-ruled={amount.ruled ? 'true' : undefined}
        role={amount.role}
      >
        {amount.children}
      </View>
      <View
        style={columnStyle(REVIEW_COLUMNS.status)}
        data-testid={status.testId}
        data-ruled={status.ruled ? 'true' : undefined}
        role={status.role}
      >
        {status.children}
      </View>
    </>
  );
}
