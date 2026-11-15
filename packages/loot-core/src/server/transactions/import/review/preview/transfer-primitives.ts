/**
 * Transfer-target primitives. Pure, shared, and IO-free.
 *
 * A "transfer" moves money between two budget accounts. Actual models it
 * with a hidden PER-ACCOUNT payee: the transaction's payee is the target
 * account's transfer payee, and upstream's import path creates the mirror
 * transaction in the target account with the amount negated.
 *
 * Why this module exists rather than living in the client's payload
 * builder: the CODES live with the rules that produce them, so a code
 * cannot be raised somewhere the sentence for it does not exist.
 *
 * The transfer target is an ACCOUNT id, not a payee id. The conversion
 * happens at send time, because only the apply step knows which payees
 * are live.
 *
 * Pure: every helper returns a new value; nothing here touches React, the
 * filesystem, or the server.
 */

/**
 * Codes emitted by `validateTransferRow`.
 *
 * Stable, greppable, value-free: they never carry an account id or a
 * payee name.
 */
export type TransferErrorCode = 'TRANSFER-001';

export class TransferValidationError extends Error {
  readonly code: TransferErrorCode;
  constructor(code: TransferErrorCode, message: string) {
    super(message);
    this.name = 'TransferValidationError';
    this.code = code;
  }
}
