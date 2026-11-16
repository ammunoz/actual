import { reconcileTransactions } from '#server/accounts/sync';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import * as prefs from '#server/prefs';
import {
  insertRule,
  loadRules,
  resetState,
} from '#server/transactions/transaction-rules';

/**
 * THE PROOF TEST — work item 0 of the rules-as-vendor-map plan.
 *
 * ## What this decides
 *
 * The plan proposes that the review creates upstream **rules** mid-import
 * and that a rule-controlled row is **locked**: the review shows the
 * rule's value, and the rule's value is what lands.
 *
 * That rests on one question:
 *
 * > **When the user picks a category in the review and a rule also sets
 * > that row's category, which one lands in the budget?**
 *
 * The answer decides whether the lock is a **display choice** (the review
 * shows the rule's value and the payload sends it too — the lock is
 * honest) or a **correctness fix** (the payload sends the user's value,
 * the rule overwrites it during import, and the user's choice is silently
 * lost).
 *
 * ## THE ANSWER
 *
 * **It is a correctness fix.** The two paths disagree:
 *
 * - **INSERT** (not already in the budget): the **rule wins**. Its `set`
 *   overwrites the category the review sent, unconditionally. The user's
 *   pick is silently lost.
 * - **UPDATE** (already in the budget): the **existing** category wins
 *   (`existing.category || trans.category`). A rule fills an *empty*
 *   existing category, but does not override an already-set one.
 *
 * The same holds for `notes` and for `payee`.
 *
 * So the review must show the rule's value **and** the payload must send
 * it. Showing the rule's value while still sending the user's pick would
 * make the display honest and the import wrong.
 *
 * **The control** is the "a rule that does NOT match" test: it proves the
 * user's category survives when no rule applies, so the other tests really
 * are the rule's doing.
 *
 * ## A note on the manual-edit path
 *
 * Upstream's *manual* edit path protects the user's value through
 * `shouldApplyRuleChange` (`desktop-client/src/components/transactions/
 * table/utils.ts`). That is a **client-side** merge, and it does not
 * apply to the import path. The import path has no such guard:
 * `action.ts` does `object[this.field] = this.value` unconditionally.
 *
 * These tests are about the IMPORT path only.
 *
 * ## Placement
 *
 * This file lives under `review/**`, which the fork owns, so it adds
 * nothing to the upstream footprint.
 *
 * ## The setup, and why it is in this order
 *
 * The `beforeEach` below empties the database, resets the rules cache and
 * loads the mappings — upstream's own ordering, from
 * `packages/loot-core/src/server/transactions/transaction-rules.test.ts`:
 * a fresh database, the rules cache reset, and the mappings loaded.
 *
 * `setup()` then calls `loadRules()`, which populates the in-memory rule
 * cache (`allRules`) and installs the sync listener. **It must run
 * BEFORE the rules are inserted**, and it does — the rules are inserted
 * inside each test, after `setup()`.
 *
 * The insert reaches the cache through the sync path, not directly:
 *
 *   insertRule -> db.insert -> sendMessages (awaited) -> _applyMessages
 *     -> _syncListeners.forEach -> onApplySync -> allRules.set
 *
 * which is why the ordering matters. Upstream's own test asserts the
 * same thing — *"Make sure it was projected"* — right after its
 * `insertRule`.
 *
 * ## The category group
 *
 * `insertCategoryGroup` throws if a group with that name already exists,
 * so the group is created **once**, in `setup()`, and every category in
 * these tests lives in it. Creating it per-category fails on the second
 * call.
 *
 * ## A note on `stage`
 *
 * The rules here use `stage: 'pre'`. The import path's rule run does not
 * filter by stage — the rule indexer indexes every rule and `runRules`
 * applies whatever it finds — so `'pre'` and `null` behave identically
 * here. `'pre'` is used because it is what upstream's own
 * `updateCategoryRules` writes.
 */

beforeEach(async () => {
  await global.emptyDatabase()();
  resetState();
  await loadMappings();
});

const ACCOUNT = 'one';

async function setup(): Promise<string> {
  await prefs.loadPrefs();
  await db.insertAccount({ id: ACCOUNT, name: 'Demo Checking' });
  const groupId = await db.insertCategoryGroup({ name: 'Demo Food' });
  await loadRules();
  return groupId;
}

/**
 * A category, in the shared group.
 *
 * `insertCategory` requires a `cat_group` — the group id, not a name — so
 * the group is created once in `setup()` and its id is passed down.
 *
 * The group is created once because category-group names are unique:
 * `insertCategoryGroup` throws if one already exists.
 */
async function addCategory(groupId: string, name: string): Promise<string> {
  return db.insertCategory({ name, cat_group: groupId });
}

/** The one transaction in the account. */
function getRows<T>(column: 'category' | 'notes' | 'payee'): T[] {
  const rows = db.runQuery<T>(
    `SELECT ${column} FROM v_transactions WHERE account = ?`,
    [ACCOUNT],
    true,
  );
  // Exactly one row, always. Without this, a regression that added a
  // second row would still let `rows[0]` pass every assertion below.
  expect(rows.length).toBe(1);
  return rows;
}

/** The category of the one transaction in the account. */
function getCategory(): string | null {
  return getRows<{ category: string | null }>('category')[0].category;
}

/** The notes of the one transaction in the account. */
function getNotes(): string | null {
  return getRows<{ notes: string | null }>('notes')[0].notes;
}

/** The payee of the one transaction in the account. */
function getPayee(): string | null {
  return getRows<{ payee: string | null }>('payee')[0].payee;
}

/** A rule: `imported_payee contains "COFFEE"` → `set category`. */
async function addCategoryRule(categoryId: string): Promise<void> {
  await insertRule({
    stage: 'pre',
    conditionsOp: 'and',
    conditions: [{ op: 'contains', field: 'imported_payee', value: 'COFFEE' }],
    actions: [{ op: 'set', field: 'category', value: categoryId }],
  });
}

describe('a rule against a category chosen in the review', () => {
  test('on the INSERT path, the rule wins over the category the review sent', async () => {
    const groupId = await setup();

    const ruleCategory = await addCategory(groupId, 'Demo Coffee Shops');
    const userCategory = await addCategory(groupId, 'Demo Dining Out');

    await addCategoryRule(ruleCategory);

    // The review sends the USER's choice — the payload builder prefers
    // `row.edits.categoryId`
    // (desktop-client/src/import-review/build-payload.ts:237-241).
    const { added, updated } = await reconcileTransactions(ACCOUNT, [
      {
        date: '2026-09-07',
        amount: -450,
        imported_payee: 'SQ *COFFEE 415',
        imported_id: 'FITID-1',
        category: userCategory,
      },
    ]);

    // It took the insert path: one new row, nothing updated.
    expect(added.length).toBe(1);
    expect(updated.length).toBe(0);

    // THE ANSWER: the rule's category is what landed.
    expect(getCategory()).toBe(ruleCategory);
  });

  test('the rule applies when the review sent NO category', async () => {
    // This is not a control — it shows the rule's value is the only
    // source of the category when the review supplies none.
    const groupId = await setup();

    const ruleCategory = await addCategory(groupId, 'Demo Coffee Shops');

    await addCategoryRule(ruleCategory);

    const { added, updated } = await reconcileTransactions(ACCOUNT, [
      {
        date: '2026-09-07',
        amount: -450,
        imported_payee: 'SQ *COFFEE 415',
        imported_id: 'FITID-1',
      },
    ]);

    expect(added.length).toBe(1);
    expect(updated.length).toBe(0);

    expect(getCategory()).toBe(ruleCategory);
  });

  test("a rule that does NOT match leaves the review's category alone", async () => {
    // THE CONTROL. If the user's category did not survive here, the
    // other tests would be proving something else entirely.
    const groupId = await setup();

    const ruleCategory = await addCategory(groupId, 'Demo Coffee Shops');
    const userCategory = await addCategory(groupId, 'Demo Dining Out');

    // The rule matches a DIFFERENT vendor.
    await insertRule({
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [
        { op: 'contains', field: 'imported_payee', value: 'BOOKSHOP' },
      ],
      actions: [{ op: 'set', field: 'category', value: ruleCategory }],
    });

    await reconcileTransactions(ACCOUNT, [
      {
        date: '2026-09-07',
        amount: -450,
        imported_payee: 'SQ *COFFEE 415',
        imported_id: 'FITID-1',
        category: userCategory,
      },
    ]);

    // The user's category survives — so the first test really is the
    // rule's doing, not an artefact of the import.
    expect(getCategory()).toBe(userCategory);
  });

  test('on the UPDATE path, the EXISTING category wins over the rule', async () => {
    const groupId = await setup();

    const ruleCategory = await addCategory(groupId, 'Demo Coffee Shops');
    const existingCategory = await addCategory(
      groupId,
      'Demo Already Categorised',
    );
    // A third category, sent on the re-import. If the rule's value won,
    // the assertion below would fail — so this also falsifies
    // "the sent category wins".
    const userCategory = await addCategory(groupId, 'Demo Dining Out');

    // The transaction is imported BEFORE the rule exists, with a
    // category of its own.
    await reconcileTransactions(ACCOUNT, [
      {
        date: '2026-09-07',
        amount: -450,
        imported_payee: 'SQ *COFFEE 415',
        imported_id: 'FITID-1',
        category: existingCategory,
      },
    ]);
    expect(getCategory()).toBe(existingCategory);

    // Now the rule appears, and the same file is imported again — this
    // time with a DIFFERENT category the review sent.
    await addCategoryRule(ruleCategory);

    const { added, updated } = await reconcileTransactions(ACCOUNT, [
      {
        date: '2026-09-07',
        amount: -450,
        imported_payee: 'SQ *COFFEE 415',
        imported_id: 'FITID-1',
        category: userCategory,
      },
    ]);

    // It matched by imported_id and took the update path: no new row.
    //
    // `updated` is empty because *nothing was written*: the existing
    // category wins, so no field differs from what is already there.
    // Upstream's own `import-contract.test.ts` notes the same thing —
    // `updated` reports fields that actually changed.
    //
    // This relies on every other field being unchanged by the re-import
    // — `imported_id`, `imported_payee`, `notes`, `payee` and `cleared`
    // all carry the same values. If normalisation ever derived a payee
    // from `imported_payee`, or the default cleared state moved, this
    // assertion would fail for an unrelated reason.
    //
    // Read this test together with "the rule fills an EMPTY existing
    // category" below: that one proves updates *do* happen, so this
    // test's empty `updated` means "nothing changed", not "nothing ever
    // changes".
    expect(added.length).toBe(0);
    expect(updated.length).toBe(0);

    // The EXISTING category wins: `existing.category || trans.category`.
    // So on a re-import, a rule does NOT override what is already there.
    expect(getCategory()).toBe(existingCategory);
  });

  test('on the UPDATE path, the rule fills an EMPTY existing category', async () => {
    // The other half of the update path: `existing.category || trans.category`
    // means the rule's category is used only when there is no category yet.
    const groupId = await setup();

    const ruleCategory = await addCategory(groupId, 'Demo Coffee Shops');

    // Imported with no category.
    await reconcileTransactions(ACCOUNT, [
      {
        date: '2026-09-07',
        amount: -450,
        imported_payee: 'SQ *COFFEE 415',
        imported_id: 'FITID-1',
      },
    ]);
    expect(getCategory()).toBe(null);

    await addCategoryRule(ruleCategory);

    const { added, updated } = await reconcileTransactions(ACCOUNT, [
      {
        date: '2026-09-07',
        amount: -450,
        imported_payee: 'SQ *COFFEE 415',
        imported_id: 'FITID-1',
      },
    ]);

    expect(added.length).toBe(0);
    expect(updated.length).toBe(1);

    // The rule's category fills the blank.
    expect(getCategory()).toBe(ruleCategory);
  });

  test('a rule that sets notes clobbers the notes the review sent', async () => {
    // The "Wanted category: X" note depends on this: if a notes rule
    // wins unconditionally, the note cannot be guaranteed to survive
    // the import.
    await setup();

    await insertRule({
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [
        { op: 'contains', field: 'imported_payee', value: 'COFFEE' },
      ],
      actions: [{ op: 'set', field: 'notes', value: 'rule notes' }],
    });

    const { added, updated } = await reconcileTransactions(ACCOUNT, [
      {
        date: '2026-09-07',
        amount: -450,
        imported_payee: 'SQ *COFFEE 415',
        imported_id: 'FITID-1',
        notes: 'Wanted category: Clothing',
      },
    ]);

    expect(added.length).toBe(1);
    expect(updated.length).toBe(0);

    expect(getNotes()).toBe('rule notes');
  });

  test('a payee rule wins over the payee the review sent', async () => {
    // The same question, for the other field the review resolves. The
    // neighbouring `import-contract.test.ts` covers "the existing payee
    // wins" on the update path; this covers "the rule wins" on the
    // insert path.
    await setup();

    const rulePayee = await db.insertPayee({ name: 'Demo Coffee Chain' });
    const userPayee = await db.insertPayee({ name: 'Demo My Payee' });

    await insertRule({
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [
        { op: 'contains', field: 'imported_payee', value: 'COFFEE' },
      ],
      actions: [{ op: 'set', field: 'payee', value: rulePayee }],
    });

    const { added, updated } = await reconcileTransactions(ACCOUNT, [
      {
        date: '2026-09-07',
        amount: -450,
        imported_payee: 'SQ *COFFEE 415',
        imported_id: 'FITID-1',
        payee: userPayee,
      },
    ]);

    expect(added.length).toBe(1);
    expect(updated.length).toBe(0);

    expect(getPayee()).toBe(rulePayee);
  });
});
