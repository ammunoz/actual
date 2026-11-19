import type { SVGProps } from 'react';

/**
 * The bank building that opens the destination caption.
 *
 * The component library has no bank/building icon — only a wallet, a card
 * and a piggy bank — so this one local glyph keeps the caption's meaning
 * ("where the file is going") without borrowing an icon that says
 * something else. It is the mockup's path and takes its ink from
 * `currentColor`, like the library's icons do.
 */
export function BankIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      aria-hidden="true"
      style={{ color: 'inherit', ...props.style }}
    >
      <path
        d="M10 2 1 6v2h18V6zM3 9v8h3V9zm5 0v8h4V9zm6 0v8h3V9zM1 19h18v1H1z"
        fill="currentColor"
      />
    </svg>
  );
}
