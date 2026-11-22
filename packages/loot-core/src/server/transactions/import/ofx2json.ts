// @ts-strict-ignore
import { parseStringPromise } from 'xml2js';

import { dayFromDate } from '#shared/months';

type OFXTransaction = {
  amount: string;
  fitId: string;
  name: string;
  date: string;
  memo: string;
  type: string;
};

export type OFXParseResult = {
  headers: Record<string, unknown>;
  transactions: OFXTransaction[];
  /**
   * Bank-account identities declared by the file, one per statement.
   *
   * A file can contain several statements, and a single statement may omit
   * its institution or bank details. Each identity is a stable key made from
   * the bank id and account id (`BANKID|ACCTID`) when both are present, or
   * the institution and account id (`ORG|FID|ACCTID`) otherwise. Entries with
   * no usable identity are left out entirely.
   */
  ofxIdentities: string[];
};

function sgml2Xml(sgml) {
  return sgml
    .replace(/&/g, '&#038;') // Replace ampersands
    .replace(/&amp;/g, '&#038;')
    .replace(/>\s+</g, '><') // remove whitespace inbetween tag close/open
    .replace(/\s+</g, '<') // remove whitespace before a close tag
    .replace(/>\s+/g, '>') // remove whitespace after a close tag
    .replace(/\.(?=[^<>]*>)/g, '') // Remove dots in tag names
    .replace(/<(\w+?)>([^<]+)/g, '<$1>$2</<added>$1>') // Add a new end-tags for the ofx elements
    .replace(/<\/<added>(\w+?)>(<\/\1>)?/g, '</$1>'); // Remove duplicate end-tags
}

export function html2Plain(value) {
  return value
    ?.replace(/&lt;/g, '<') // lessthan
    .replace(/&gt;/g, '>') // greaterthan
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/(&amp;|&#038;)/g, '&'); // ampersands
}

async function parseXml(content) {
  return await parseStringPromise(content, {
    explicitArray: false,
    trim: true,
  });
}

function getStmtTrn(data) {
  const ofx = data?.['OFX'];
  if (ofx?.['CREDITCARDMSGSRSV1'] != null) {
    return getCcStmtTrn(ofx);
  } else if (ofx?.['INVSTMTMSGSRSV1'] != null) {
    return getInvStmtTrn(ofx);
  } else {
    return getBankStmtTrn(ofx);
  }
}

function getBankStmtTrn(ofx) {
  // Somes values could be an array or a single object.
  // xml2js serializes single item to an object and multiple to an array.
  const msg = ofx?.['BANKMSGSRSV1'];
  const stmtTrnRs = getAsArray(msg?.['STMTTRNRS']);
  const result = stmtTrnRs.flatMap(s => {
    const stmtRs = s?.['STMTRS'];
    const tranList = stmtRs?.['BANKTRANLIST'];
    const stmtTrn = tranList?.['STMTTRN'];
    return getAsArray(stmtTrn);
  });
  return result;
}

function getCcStmtTrn(ofx) {
  // Some values could be an array or a single object.
  // xml2js serializes single item to an object and multiple to an array.
  const msg = ofx?.['CREDITCARDMSGSRSV1'];
  const stmtTrnRs = getAsArray(msg?.['CCSTMTTRNRS']);
  const result = stmtTrnRs.flatMap(s => {
    const stmtRs = s?.['CCSTMTRS'];
    const tranList = stmtRs?.['BANKTRANLIST'];
    const stmtTrn = tranList?.['STMTTRN'];
    return getAsArray(stmtTrn);
  });
  return result;
}

function getInvStmtTrn(ofx) {
  // Somes values could be an array or a single object.
  // xml2js serializes single item to an object and multiple to an array.
  const msg = ofx?.['INVSTMTMSGSRSV1'];
  const stmtTrnRs = getAsArray(msg?.['INVSTMTTRNRS']);
  const result = stmtTrnRs.flatMap(s => {
    const stmtRs = s?.['INVSTMTRS'];
    const tranList = stmtRs?.['INVTRANLIST'];
    const stmtTrn = tranList?.['INVBANKTRAN']?.flatMap(t => t?.['STMTTRN']);
    return getAsArray(stmtTrn);
  });
  return result;
}

function getAsArray(value) {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

/**
 * The financial institution declared by the file's sign-on response.
 *
 * OFX calls the institution id `FID` (there is no `FIID` element), paired
 * with the human-readable `ORG`. Both may be absent — many banks omit the
 * whole `FI` block — so callers must treat this as optional.
 */
function getOfxFi(data): { ORG?: string; FID?: string } | undefined {
  return data?.['OFX']?.['SIGNONMSGSRSV1']?.['SONRS']?.['FI'];
}

function normalizeOfxValue(value): string {
  return value == null ? '' : String(value).trim();
}

/**
 * Build the identity for one statement's account id.
 *
 * A bank statement supplies `BANKID` and `ACCTID`, which together identify
 * the account (`BANKID|ACCTID`) — the bank id alone is not enough, since one
 * bank has many accounts. Credit-card and investment statements have no
 * `BANKID`, so their `ACCTID` is paired with the file's `ORG`/`FID` instead.
 */
function buildOfxIdentity(
  accountId: string,
  bankId: string,
  fi: { ORG?: string; FID?: string } | undefined,
): string | undefined {
  if (!accountId) return undefined;
  if (bankId) return `${bankId}|${accountId}`;
  const org = normalizeOfxValue(fi?.ORG);
  const fid = normalizeOfxValue(fi?.FID);
  if (!org || !fid) return undefined;
  return `${org}|${fid}|${accountId}`;
}

/**
 * Collect the identities declared by ALL statement blocks in the file.
 *
 * `getStmtTrn` deliberately dispatches to a single walker, which would miss
 * statements of other types in a mixed file. Identity collection does not
 * share that limitation: it walks bank, credit-card and investment blocks
 * independently so an account is not silently overlooked.
 */
function getOfxIdentities(data): string[] {
  const ofx = data?.['OFX'];
  if (!ofx) return [];
  const fi = getOfxFi(data);
  const identities: string[] = [];

  for (const stmtTrnRs of getAsArray(ofx['BANKMSGSRSV1']?.['STMTTRNRS'])) {
    const from = stmtTrnRs?.['STMTRS']?.['BANKACCTFROM'];
    const identity = buildOfxIdentity(
      normalizeOfxValue(from?.['ACCTID']),
      normalizeOfxValue(from?.['BANKID']),
      fi,
    );
    if (identity) identities.push(identity);
  }

  for (const stmtTrnRs of getAsArray(
    ofx['CREDITCARDMSGSRSV1']?.['CCSTMTTRNRS'],
  )) {
    const from = stmtTrnRs?.['CCSTMTRS']?.['CCACCTFROM'];
    const identity = buildOfxIdentity(
      normalizeOfxValue(from?.['ACCTID']),
      '',
      fi,
    );
    if (identity) identities.push(identity);
  }

  for (const stmtTrnRs of getAsArray(
    ofx['INVSTMTMSGSRSV1']?.['INVSTMTTRNRS'],
  )) {
    // Investment statements identify the account with `INVACCTFROM`, an
    // InvestmentAccount aggregate carrying ACCTID (and BROKERID).
    const from = stmtTrnRs?.['INVSTMTRS']?.['INVACCTFROM'];
    const accountId =
      typeof from === 'object' && from != null
        ? normalizeOfxValue(from['ACCTID'])
        : normalizeOfxValue(from);
    const identity = buildOfxIdentity(accountId, '', fi);
    if (identity) identities.push(identity);
  }

  return identities;
}

function mapOfxTransaction(stmtTrn): OFXTransaction {
  // YYYYMMDDHHMMSS format. We just need the date.
  const dtPosted = stmtTrn['DTPOSTED'];
  const transactionDate = dtPosted
    ? new Date(
        Number(dtPosted.substring(0, 4)), // year
        Number(dtPosted.substring(4, 6)) - 1, // month (zero-based index)
        Number(dtPosted.substring(6, 8)), // date
      )
    : null;

  return {
    amount: stmtTrn['TRNAMT'],
    type: stmtTrn['TRNTYPE'],
    fitId: stmtTrn['FITID'],
    date: dayFromDate(transactionDate),
    name: html2Plain(stmtTrn['NAME']),
    memo: html2Plain(stmtTrn['MEMO']),
  };
}

function decodeOfxBytes(bytes: Uint8Array): string {
  // OFX headers are always ASCII. Peek at the header section to detect
  // the declared encoding before decoding the full content.
  const headerPreview = new TextDecoder('latin1').decode(
    bytes.subarray(0, 2048),
  );

  const encodingMatch = headerPreview.match(/^ENCODING:(.+)/m);
  const charsetMatch = headerPreview.match(/^CHARSET:(.+)/m);

  const encoding = encodingMatch?.[1]?.trim().toUpperCase();
  const charset = charsetMatch?.[1]?.trim().toUpperCase();

  if (encoding === 'UTF-8') {
    return new TextDecoder('utf-8').decode(bytes);
  }

  // ENCODING:USASCII — use CHARSET to pick the right code page
  if (charset === '8859-1') {
    return new TextDecoder('iso-8859-1').decode(bytes);
  }
  if (charset === '1252') {
    return new TextDecoder('windows-1252').decode(bytes);
  }

  // Default: UTF-8 (ASCII is a subset; modern default)
  return new TextDecoder('utf-8').decode(bytes);
}

export async function ofx2json(
  ofx: string | Uint8Array,
): Promise<OFXParseResult> {
  const ofxString = typeof ofx === 'string' ? ofx : decodeOfxBytes(ofx);

  // firstly, split into the header attributes and the footer sgml
  const contents = ofxString.split(/<OFX\s?>/, 2);

  // firstly, parse the headers
  const headerString = contents[0].split(/\r?\n/);
  const headers = {};
  headerString.forEach(attrs => {
    if (attrs) {
      const headAttr = attrs.split(/:/, 2);
      headers[headAttr[0]] = headAttr[1];
    }
  });

  // make the SGML and the XML
  const content = `<OFX>${contents[1]}`;

  // Parse the XML/SGML portion of the file into an object
  // Try as XML first, and if that fails do the SGML->XML mangling
  let dataParsed = null;
  try {
    dataParsed = await parseXml(content);
  } catch {
    const sanitized = sgml2Xml(content);
    dataParsed = await parseXml(sanitized);
  }

  return {
    headers,
    transactions: getStmtTrn(dataParsed).map(mapOfxTransaction),
    ofxIdentities: getOfxIdentities(dataParsed),
  };
}
