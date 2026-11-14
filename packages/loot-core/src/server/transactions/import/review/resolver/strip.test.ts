import { canonicalize, strip, STRIP_RULES } from './strip';
import type { StripResult } from './strip';

describe('strip / STRIP_RULES', () => {
  it('has stable rule codes (one per rule, unique)', () => {
    const ids = STRIP_RULES.map(r => r.code);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('collapse-whitespace + trim-bounds is idempotent', () => {
    const input = '   Demo   Vendor   Inc. ';
    const r1 = strip(input);
    const r2 = strip(r1.canonical);
    expect(r2.canonical).toBe(r1.canonical);
  });

  it('produces stable canonical for an already-clean string', () => {
    const input = 'Demo Coffee Shop';
    const r: StripResult = strip(input);
    expect(r.canonical).toBe('Demo Coffee Shop');
  });

  it('handles null/undefined input safely', () => {
    expect(canonicalize(null)).toBe('');
    expect(canonicalize(undefined)).toBe('');
    expect(strip(null).canonical).toBe('');
  });

  it('strips Interac e-transfer prefix', () => {
    expect(canonicalize('FREE INTERAC E-TRANSFER DEPOSIT')).toBe('DEPOSIT');
  });

  it('strips POS prefixes (OPOS, POS, SP)', () => {
    // POS prefix + cascading trail-store-number -> both strip
    expect(canonicalize('POS PURCHASE 1234')).toBe('PURCHASE');
    expect(canonicalize('OPOS PURCHASE 1234')).toBe('PURCHASE');
    expect(canonicalize('OPOS VENDOR')).toBe('VENDOR');
    expect(canonicalize('SP RETAILER')).toBe('RETAILER');
  });

  it('strips trailing state abbreviation', () => {
    expect(canonicalize('Demo Coffee, CA')).toBe('Demo Coffee');
    expect(canonicalize('Demo Coffee CA')).toBe('Demo Coffee');
  });

  it('strips trailing store number', () => {
    expect(canonicalize('ACME FAST FOOD 4251')).toBe('ACME FAST FOOD');
    expect(canonicalize('PIZZA DEMO 4984')).toBe('PIZZA DEMO');
  });

  it('strips trailing corporate suffix (Inc / Ltd / Co / Corp)', () => {
    expect(canonicalize('DEMO COFFEE INC.')).toBe('DEMO COFFEE');
    expect(canonicalize('DEMO PHARMACY LTD')).toBe('DEMO PHARMACY');
    expect(canonicalize('DEMO BOOKS CORP')).toBe('DEMO BOOKS');
  });

  it('does NOT strip a single trailing all-caps word (no reliable city heuristic)', () => {
    // We deliberately do not strip a trailing city from a payee -
    // distinguishing merchant-name fragments from city tails is unreliable
    // without external knowledge. The 2-letter state rule handles ", CA"
    // tails separately.
    expect(canonicalize('Demo Coffee SPRINGFIELD')).toBe(
      'Demo Coffee SPRINGFIELD',
    );
    expect(canonicalize('FOO BAR CALGARY')).toBe('FOO BAR CALGARY');
  });

  it('report fired rule indices for non-trivial transformations', () => {
    const r: StripResult = strip('FREE INTERAC E-TRANSFER DEMO COFFEE INC. ');
    expect(r.fired.length).toBeGreaterThan(0);
    expect(r.canonical).toBe('DEMO COFFEE');
  });

  it('empty / whitespace-only input returns canonical "" with no fired rules', () => {
    const r1 = strip('');
    expect(r1.canonical).toBe('');
    expect(r1.fired).toEqual([]);
    const r2 = strip('    ');
    expect(r2.canonical).toBe('');
  });

  it('does not strip words inside the string (only trailing)', () => {
    const s = canonicalize('Demo Foo Inc Bar');
    expect(s).toBe('Demo Foo Inc Bar');
  });

  it('is deterministic: same input, same output, no time-dependence', () => {
    const a = strip('Demo Coffee 4251');
    const b = strip('Demo Coffee 4251');
    expect(a.canonical).toBe(b.canonical);
    expect(a.fired).toEqual(b.fired);
  });

  it('preserves non-ASCII / accented characters', () => {
    expect(canonicalize('Café Olé TESTVILLE')).toBe('Café Olé TESTVILLE');
  });
});
