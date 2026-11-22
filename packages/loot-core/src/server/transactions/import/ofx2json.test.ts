import { readFileSync } from 'node:fs';

import { html2Plain, ofx2json } from './ofx2json';

describe('html2Plain', () => {
  test('regular text works', async () => {
    expect(html2Plain('Hello, world!')).toBe('Hello, world!');
    expect(html2Plain('Hello, <b>world</b>!')).toBe('Hello, <b>world</b>!');
  });

  test('brackets are unescaped', async () => {
    expect(html2Plain('Hello, &lt;world&gt;!')).toBe('Hello, <world>!');
  });
  test('apostrophes are unescaped', async () => {
    expect(html2Plain('Hello, &#39;world&#39;!')).toBe("Hello, 'world'!");
  });
  test('quotes are unescaped', async () => {
    expect(html2Plain('Hello, &quot;world&quot;!')).toBe('Hello, "world"!');
  });
  test('ampersands are unescaped', async () => {
    expect(html2Plain('Hello, &amp;world&amp;!')).toBe('Hello, &world&!');
    expect(html2Plain('Hello, &#038;world&#038;!')).toBe('Hello, &world&!');
  });
  test('no double unescaping with other entities', async () => {
    expect(html2Plain('Hello, &amp;#038;world&amp;#038;!')).toBe(
      'Hello, &#038;world&#038;!',
    );
    expect(html2Plain('Hello, &#038;amp;world&#038;amp;!')).toBe(
      'Hello, &amp;world&amp;!',
    );
    expect(html2Plain('Hello, &amp;quot;world&amp;quot;!')).toBe(
      'Hello, &quot;world&quot;!',
    );
  });
});

function readFixture(name: string): string {
  return readFileSync(`${__dirname}/../../../mocks/files/${name}`, 'utf8');
}

/** A minimal bank statement with the given BANKID/ACCTID. */
function bankStatement(bankId: string, acctId: string): string {
  return `<STMTTRNRS>
  <STMTRS>
    <BANKACCTFROM><BANKID>${bankId}</BANKID><ACCTID>${acctId}</ACCTID></BANKACCTFROM>
    <BANKTRANLIST>
      <STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260101000000<TRNAMT>-1.00<FITID>F${acctId}<NAME>V</STMTTRN>
    </BANKTRANLIST>
  </STMTRS>
</STMTTRNRS>`;
}

const OFX_HEADERS = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
ENCODING:USASCII
CHARSET:1252

`;

describe('ofxIdentities', () => {
  test('a bank statement uses BANKID|ACCTID, not the institution', async () => {
    const result = await ofx2json(readFixture('data.ofx'));
    expect(result.ofxIdentities).toEqual(['012345678|123456789123']);
  });

  test('a credit-card statement uses ORG|FID|ACCTID', async () => {
    const result = await ofx2json(readFixture('credit-card.ofx'));
    expect(result.ofxIdentities).toEqual([
      'Apple Card|12345|7dc6a2fd-2124-457a-a14',
    ]);
  });

  test('a file with no FI block still gets the bank identity', async () => {
    const result = await ofx2json(readFixture('data-payee-memo.ofx'));
    expect(result.ofxIdentities).toEqual(['012345678|123456789123']);
  });

  test('a file with no account identity yields none', async () => {
    const file = `${OFX_HEADERS}<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    expect((await ofx2json(file)).ofxIdentities).toEqual([]);
  });

  test('every statement in a multi-statement file gets an identity', async () => {
    const file = `${OFX_HEADERS}<OFX><BANKMSGSRSV1>
      ${bankStatement('B1', 'A1')}
      ${bankStatement('B1', 'A2')}
    </BANKMSGSRSV1></OFX>`;
    expect((await ofx2json(file)).ofxIdentities).toEqual(['B1|A1', 'B1|A2']);
  });

  test('a bank statement without BANKID falls back to ORG|FID|ACCTID', async () => {
    const from = '<BANKACCTFROM><ACCTID>A1</ACCTID></BANKACCTFROM>';
    const fi = '<SIGNONMSGSRSV1><SONRS><FI><ORG>Bank</ORG><FID>42</FID></FI></SONRS></SIGNONMSGSRSV1>';
    const file = `${OFX_HEADERS}<OFX>${fi}<BANKMSGSRSV1>
      <STMTTRNRS><STMTRS>${from}<BANKTRANLIST></BANKTRANLIST></STMTRS></STMTTRNRS>
    </BANKMSGSRSV1></OFX>`;
    expect((await ofx2json(file)).ofxIdentities).toEqual(['Bank|42|A1']);
  });

  test('an investment statement uses INVACCTFROM with the institution', async () => {
    const inv = `<INVSTMTTRNRS><INVSTMTRS>
      <INVACCTFROM><BROKERID>B1</BROKERID><ACCTID>INV-1</ACCTID></INVACCTFROM>
      <INVTRANLIST></INVTRANLIST>
    </INVSTMTRS></INVSTMTTRNRS>`;
    const fi = '<SIGNONMSGSRSV1><SONRS><FI><ORG>Broker</ORG><FID>9</FID></FI></SONRS></SIGNONMSGSRSV1>';
    const file = `${OFX_HEADERS}<OFX>${fi}<INVSTMTMSGSRSV1>${inv}</INVSTMTMSGSRSV1></OFX>`;
    expect((await ofx2json(file)).ofxIdentities).toEqual([
      'Broker|9|INV-1',
    ]);
  });

  test('identities are collected from all statement types in a mixed file', async () => {
    const cc = `<CCSTMTTRNRS><CCSTMTRS>
      <CCACCTFROM><ACCTID>CC-1</ACCTID></CCACCTFROM>
      <BANKTRANLIST></BANKTRANLIST>
    </CCSTMTRS></CCSTMTTRNRS>`;
    const file = `${OFX_HEADERS}<OFX>
      <SIGNONMSGSRSV1><SONRS><FI><ORG>Bank</ORG><FID>123</FID></FI></SONRS></SIGNONMSGSRSV1>
      <BANKMSGSRSV1>${bankStatement('B1', 'A1')}</BANKMSGSRSV1>
      <CREDITCARDMSGSRSV1>${cc}</CREDITCARDMSGSRSV1>
    </OFX>`;
    expect((await ofx2json(file)).ofxIdentities).toEqual([
      'B1|A1',
      'Bank|123|CC-1',
    ]);
  });
});
