import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  bindingDecision,
  canonicalJson,
  compareExistingEvent,
  eventKey,
  bindingKey,
  validateEnvelope,
} from '../public/js/purchase-inbox-core.js';

const base = {
  event_id: 'evt-001',
  event_type: 'purchase_confirmed',
  source_system: 'zaikobang',
  source_tenant: 'zaikobang:integration-test',
  inventory_unit_id: 'zaikobang:test:unit-0001',
  occurred_at: '2026-09-09T00:00:00.000Z',
  schema_version: 'v1',
  payload: { purchase_price: null, purchase_price_status: 'unknown', supplier: 'test' },
  payload_sha256: 'a'.repeat(64),
};

test('canonical JSON sorts object keys and preserves null/zero', () => {
  assert.equal(canonicalJson({ b: 0, a: null }), '{"a":null,"b":0}');
});

test('event key is source tenant scoped', () => {
  assert.equal(eventKey(base), 'zaikobang:integration-test:evt-001');
});

test('binding key is source tenant and Unit scoped', () => {
  assert.equal(bindingKey(base), 'zaikobang:integration-test:zaikobang:test:unit-0001');
});

test('valid purchase_confirmed envelope is accepted', () => {
  assert.equal(validateEnvelope(base).ok, true);
});

test('missing event id is rejected', () => {
  const result = validateEnvelope({ ...base, event_id: '' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('invalid_event_id'));
});

test('non-purchase event is rejected', () => {
  const result = validateEnvelope({ ...base, event_type: 'listing_created' });
  assert.ok(result.errors.includes('unsupported_event_type'));
});

test('local-user source tenant is rejected', () => {
  const result = validateEnvelope({ ...base, source_tenant: 'local-user' });
  assert.ok(result.errors.includes('unstable_source_tenant'));
});

test('Firebase-like source tenant is rejected', () => {
  const result = validateEnvelope({ ...base, source_tenant: 'firebase:uid' });
  assert.ok(result.errors.includes('unstable_source_tenant'));
});

test('null purchase price remains valid payload data', () => {
  assert.equal(validateEnvelope(base).ok, true);
  assert.equal(base.payload.purchase_price, null);
});

test('zero purchase price remains distinct', () => {
  const event = { ...base, payload: { purchase_price: 0, purchase_price_status: 'known' } };
  assert.equal(event.payload.purchase_price, 0);
  assert.equal(event.payload.purchase_price_status, 'known');
});

test('same event and same hash is duplicate', () => {
  assert.equal(compareExistingEvent({ payload_sha256: 'A'.repeat(64) }, 'a'.repeat(64)), 'duplicate');
});

test('same event and different hash is conflict', () => {
  assert.equal(compareExistingEvent({ payload_sha256: 'a'.repeat(64) }, 'b'.repeat(64)), 'conflict');
});

test('missing existing event is accepted', () => {
  assert.equal(compareExistingEvent(null, 'a'.repeat(64)), 'accepted');
});

test('new Unit to unbound item can bind', () => {
  assert.equal(bindingDecision(null, {}, base.inventory_unit_id, 'item-1'), 'bind');
});

test('same Unit and same item is duplicate bind', () => {
  assert.equal(bindingDecision({ itemId: 'item-1' }, { inventory_unit_id: base.inventory_unit_id }, base.inventory_unit_id, 'item-1'), 'duplicate');
});

test('existing same-item claim repairs a missing local Unit field', () => {
  assert.equal(bindingDecision({ itemId: 'item-1' }, {}, base.inventory_unit_id, 'item-1'), 'repair');
});

test('same Unit and different item is conflict', () => {
  assert.equal(bindingDecision({ itemId: 'item-1' }, {}, base.inventory_unit_id, 'item-2'), 'unit_conflict');
});

test('different Unit and already bound item is conflict', () => {
  assert.equal(bindingDecision(null, { inventory_unit_id: 'other-unit' }, base.inventory_unit_id, 'item-1'), 'item_conflict');
});

test('Inbox module has no Mercari/session boundary references', () => {
  const source = fs.readFileSync(new URL('../public/js/purchase-inbox.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /api\/mercari|MercariService|open_page|cookie|session|route provenance|identity proof|electron/i);
});

test('Inbox UI does not auto-bind from product identifiers', () => {
  const source = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const module = fs.readFileSync(new URL('../public/js/purchase-inbox.js', import.meta.url), 'utf8');
  assert.match(source, /この商品として登録/);
  assert.match(source, /purchase-inbox-select|data-inbox-select/);
  assert.doesNotMatch(module, /title.*match|JAN|ISBN|ASIN|similarity/i);
});

test('item persistence explicitly lists integration fields', () => {
  const source = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(source, /inventory_unit_id: prev\?\.inventory_unit_id/);
  assert.match(source, /integration: prev\?\.integration/);
});

test('Inbox uses a dedicated IndexedDB database and stores', () => {
  const source = fs.readFileSync(new URL('../public/js/purchase-inbox.js', import.meta.url), 'utf8');
  assert.match(source, /furimora_integration_inbox_v1/);
  assert.match(source, /createObjectStore\(STORE_EVENTS/);
  assert.match(source, /createObjectStore\(STORE_AUDITS/);
  assert.match(source, /createObjectStore\(STORE_BINDINGS/);
  assert.doesNotMatch(source, /localStorage\./);
});

test('bind is online-only and uses an atomic Firestore transaction', () => {
  const source = fs.readFileSync(new URL('../public/js/purchase-inbox.js', import.meta.url), 'utf8');
  assert.match(source, /navigator\.onLine === false/);
  assert.match(source, /firestore\.runTransaction\(async \(tx\) =>/);
  assert.match(source, /tx\.set\(refs\.claimRef/);
  assert.match(source, /tx\.set\(refs\.itemRef/);
  assert.match(source, /tx\.set\(refs\.inboxRef/);
  assert.match(source, /event_id: record\.event_id/);
  assert.match(source, /payload_sha256: record\.payload_sha256/);
  assert.match(source, /binding_doc_id: refs\.claimRef\.id/);
});

test('stale replay cannot downgrade cloud bound/conflict state', () => {
  const source = fs.readFileSync(new URL('../public/js/purchase-inbox.js', import.meta.url), 'utf8');
  assert.match(source, /existing\?\.status === 'bound' && record\.status !== 'bound'/);
  assert.match(source, /existing\?\.status === 'conflict' && record\.status !== 'conflict'/);
  assert.match(source, /local\?\.status === 'bound' && remote\.status !== 'bound'/);
});

test('cloud conflict preserves the first hash and appends later evidence', () => {
  const source = fs.readFileSync(new URL('../public/js/purchase-inbox.js', import.meta.url), 'utf8');
  assert.match(source, /hashConflict/);
  assert.match(source, /payload_sha256: existing\.payload_sha256/);
  assert.match(source, /conflicts: \[\.\.\.\(existing\.conflicts \|\| \[\]\), \.\.\.\(record\.conflicts \|\| \[\]\)\]/);
});

test('cloud failures do not erase locally durable audit/import state', () => {
  const source = fs.readFileSync(new URL('../public/js/purchase-inbox.js', import.meta.url), 'utf8');
  assert.match(source, /refs\.auditRef\.set\([\s\S]*?\.catch\(\(\) => \{\}\)/);
  assert.match(source, /writeInboxToCloud\(record\)\.catch\(\(\) => \{\}\)/);
});

test('bind UI carries event keys through data attributes, not executable HTML', () => {
  const source = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(source, /data-inbox-bind=/);
  assert.match(source, /data-inbox-new=/);
  assert.doesNotMatch(source, /onclick="bindPurchaseInbox\(/);
  assert.doesNotMatch(source, /onclick="openNewItemFromPurchaseInbox\(/);
});

test('Firestore rules isolate the new top-level collections and keep claims immutable', () => {
  const rules = fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.match(rules, /match \/purchaseInbox\//);
  assert.match(rules, /match \/inventoryUnitBindings\//);
  assert.match(rules, /match \/purchaseInboxAudits\//);
  assert.match(rules, /Missing claim reads are required/);
  assert.match(rules, /Missing claim reads are required|transaction must be able to read/);
  assert.match(rules, /allow update, delete: if false/);
  assert.match(rules, /request\.resource\.data\.status == 'bound'/);
  assert.match(rules, /existsAfter\([\s\S]*inventoryUnitBindings/);
  assert.match(rules, /getAfter\([\s\S]*\.data\.itemId/);
});

test('Firestore rules let a delete through (payload:null must never hit .keys())', () => {
  const rules = fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  // 削除は payload:null を書く。null に .keys() を当てると条件が落ち、
  // 削除の書き込みが permission-denied になって同期全体が止まる（2026-09-12 に本番で実測）
  assert.match(rules, /data\.payload is map/);
  assert.match(rules, /function isTombstoneWrite\(\)/);
  assert.match(rules, /isTombstoneWrite\(\) \|\| itemIntegrationWriteAllowed\(\)/);
  // payload の中身を見るのは `is map` で確かめた直後だけ。素の `.payload.keys()` を残さない
  const lines = rules.split('\n');
  const unguarded = lines.filter((line, i) => {
    if (!/\.payload\.keys\(\)/.test(line)) return false;
    const prev = lines[i - 1] || '';
    return !/\.payload is map/.test(prev) && !/\.payload is map/.test(line);
  });
  assert.deepEqual(unguarded, [], `is map の確認なしに payload.keys() を読んでいる行:\n${unguarded.join('\n')}`);
});

test('Inbox integration does not touch Mercari/Electron boundary code', () => {
  const changed = [
    'public/js/purchase-inbox.js',
    'public/js/purchase-inbox-core.js',
    'public/index.html',
    'firestore.rules',
  ];
  assert.deepEqual(changed.filter((file) => /electron|mercari|main|control|session|partition/i.test(file)), []);
});
