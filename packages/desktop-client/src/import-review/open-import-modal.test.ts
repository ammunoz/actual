import { buildImportModal, isKeyboardReviewFile } from './open-import-modal';

describe('isKeyboardReviewFile', () => {
  it('accepts OFX and QFX', () => {
    expect(isKeyboardReviewFile('/tmp/transactions.ofx')).toBe(true);
    expect(isKeyboardReviewFile('/tmp/transactions.qfx')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isKeyboardReviewFile('/tmp/TRANSACTIONS.OFX')).toBe(true);
  });

  it('rejects the other financial file types', () => {
    expect(isKeyboardReviewFile('/tmp/transactions.csv')).toBe(false);
    expect(isKeyboardReviewFile('/tmp/transactions.qif')).toBe(false);
    expect(isKeyboardReviewFile('/tmp/transactions.xml')).toBe(false);
    expect(isKeyboardReviewFile('/tmp/transactions.tsv')).toBe(false);
  });
});

describe('buildImportModal', () => {
  const onImported = (didChange: boolean) => {
    void didChange;
  };

  it('uses Actual own modal when the feature is off', () => {
    const descriptor = buildImportModal('a-1', '/tmp/t.ofx', onImported, false);
    expect(descriptor.kind).toBe('modal');
    if (descriptor.kind !== 'modal') return;
    expect(descriptor.modal.name).toBe('import-transactions');
    expect(descriptor.modal.options.accountId).toBe('a-1');
    expect(descriptor.modal.options.filename).toBe('/tmp/t.ofx');
  });

  it('uses Actual own modal for a non-OFX file even when the feature is on', () => {
    const descriptor = buildImportModal('a-1', '/tmp/t.csv', onImported, true);
    expect(descriptor.kind).toBe('modal');
  });

  it('navigates to the review page for an OFX file when the feature is on', () => {
    const descriptor = buildImportModal('a-1', '/tmp/t.ofx', onImported, true);
    expect(descriptor.kind).toBe('page');
    if (descriptor.kind !== 'page') return;
    expect(descriptor.path).toContain('/import');
    expect(descriptor.path).toContain('account=a-1');
    expect(descriptor.path).toContain('file=');
  });

  it('navigates to the review page for a QFX file when the feature is on', () => {
    const descriptor = buildImportModal('a-1', '/tmp/t.qfx', onImported, true);
    expect(descriptor.kind).toBe('page');
  });

  it('carries the onImported callback through on the modal path', () => {
    const descriptor = buildImportModal('a-1', '/tmp/t.ofx', onImported, false);
    if (descriptor.kind !== 'modal') throw new Error('expected modal');
    expect(descriptor.modal.options.onImported).toBe(onImported);
  });

  it('the off-path descriptor is identical to the on-path one for a non-OFX file', () => {
    const off = buildImportModal('a-1', '/tmp/t.csv', onImported, false);
    const on = buildImportModal('a-1', '/tmp/t.csv', onImported, true);
    expect(off).toEqual(on);
  });
});
