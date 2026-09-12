import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  buildListingCreatedEnvelope,
  buildListingPayload,
  chooseConfirmationAction,
  compareExistingEvent,
  isBoundItem,
  listingIdFor,
  normalizeListingPrice,
  uuidv7,
  validateListingCreatedEnvelope,
} from '../public/js/listing-created-core.js';

const source = fs.readFileSync(new URL('../public/js/listing-created-outbox.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

const boundItem = {
  id: 'item-1',
  inventory_unit_id: 'zaikobang:t5:unit-0001',
  integration: { source_tenant: 'zaikobang:tenant-1', purchase_confirmed_event_id: 'purchase-1' },
  currentPrice: 1700,
};

test('unbound item cannot satisfy the listing confirmation precondition', () => {
  assert.equal(isBoundItem({ id: 'item-1' }), false);
  assert.equal(isBoundItem({ ...boundItem, integration: undefined }), false);
  assert.equal(isBoundItem(boundItem), true);
});

test('human confirmation creates one listing event with the bound Unit', async () => {
  const event = await buildListingCreatedEnvelope({
    sourceTenant: 'zaikobang:tenant-1',
    inventoryUnitId: boundItem.inventory_unit_id,
    listingId: listingIdFor('018f0c2d-0000-7000-8000-000000000001'),
    eventId: 'furimora:event:confirmation-1',
    occurredAt: '2026-09-09T00:00:00.000Z',
    listingPrice: 1700,
  });
  assert.equal(validateListingCreatedEnvelope(event).ok, true);
  assert.equal(event.inventory_unit_id, boundItem.inventory_unit_id);
  assert.equal(event.payload.listing_id, 'furimora:listing:018f0c2d-0000-7000-8000-000000000001');
});

test('outbound tenant is independent from the inbound ZaikoBang tenant', () => {
  assert.match(source, /integrationTenantId/);
  assert.match(source, /const sourceTenant = assertStableTenant\(c\.integrationTenantId\)/);
  assert.doesNotMatch(source, /item\.integration\.source_tenant/);
});

test('before human confirmation there is no implicit event path', () => {
  assert.match(page, /openListingCreatedConfirm/);
  assert.match(page, /executeListingCreatedConfirm/);
  assert.doesNotMatch(page, /saveNewItem\(\)[\s\S]{0,1000}confirmListing/);
  assert.doesNotMatch(source, /openMercari|api\/mercari|MercariService|cookie|session|partition|route provenance|identity proof|electron/i);
});

test('same confirmation operation is duplicate and does not allocate another event', () => {
  const row = { item_id: 'item-1', confirmation_id: 'confirmation-1', listing_id: 'listing-1' };
  const result = chooseConfirmationAction([row], { itemId: 'item-1', confirmationId: 'confirmation-1', relist: false });
  assert.equal(result.result, 'duplicate');
  assert.equal(result.existing.listing_id, 'listing-1');
});

test('a second intentional relist keeps the Unit and gets a new listing identity', () => {
  const first = { item_id: 'item-1', confirmation_id: 'confirmation-1', listing_id: 'listing-1' };
  const result = chooseConfirmationAction([first], { itemId: 'item-1', confirmationId: 'confirmation-2', relist: true });
  assert.equal(result.result, 'accepted');
  assert.notEqual(listingIdFor('018f0c2d-0000-7000-8000-000000000001'), listingIdFor('018f0c2d-0000-7000-8000-000000000002'));
});

test('relist cannot create a first listing and a normal retry stays duplicate-safe', () => {
  assert.equal(chooseConfirmationAction([], { itemId: 'item-1', confirmationId: 'confirmation-1', relist: true }).result, 'conflict');
  assert.equal(chooseConfirmationAction([{ item_id: 'item-1', listing_id: 'L1' }], { itemId: 'item-1', confirmationId: 'confirmation-2', relist: false }).result, 'duplicate');
  assert.match(page, /openListingCreatedConfirm\(\$\{item\.id\}, false\)/);
  assert.match(page, /openListingCreatedConfirm\(\$\{item\.id\}, true\)/);
});

test('creating L2 does not mutate or cancel L1', () => {
  const l1 = { listing_id: 'L1', status: 'confirmed', item_id: 'item-1' };
  const rows = [l1, { listing_id: 'L2', status: 'confirmed', item_id: 'item-1' }];
  assert.deepEqual(rows[0], l1);
  assert.equal(rows.filter((row) => row.status === 'cancelled').length, 0);
});

test('listing_price null and zero retain different meanings', () => {
  assert.deepEqual(normalizeListingPrice(null), { amount: null, status: 'unknown', currency: 'JPY' });
  assert.deepEqual(normalizeListingPrice(0), { amount: 0, status: 'known', currency: 'JPY' });
  assert.deepEqual(buildListingPayload({ listingId: 'L1', listingPrice: null }).listing_price, { amount: null, status: 'unknown', currency: 'JPY' });
});

test('event duplicate and conflict are hash based', () => {
  assert.equal(compareExistingEvent({ payload_sha256: 'A'.repeat(64) }, 'a'.repeat(64)), 'duplicate');
  assert.equal(compareExistingEvent({ payload_sha256: 'a'.repeat(64) }, 'b'.repeat(64)), 'conflict');
});

test('listing ledger and outbox share one IndexedDB transaction', () => {
  assert.match(source, /transaction\(\[STORE_LEDGER, STORE_OUTBOX, STORE_OPERATIONS, STORE_AUDITS\], 'readwrite'\)/);
  assert.match(source, /STORE_LEDGER\)\.put\(ledgerRow\)/);
  assert.match(source, /STORE_OUTBOX\)\.put\(outboxRow\)/);
});

test('reload/restart persistence uses dedicated IndexedDB, not localStorage', () => {
  assert.match(source, /furimora_listing_created_v1/);
  assert.match(source, /createObjectStore\(STORE_LEDGER/);
  assert.match(source, /createObjectStore\(STORE_OUTBOX/);
  assert.doesNotMatch(source, /localStorage\./);
});

test('JSONL export and ack import are exposed without a network client', () => {
  assert.match(page, /exportListingCreatedJsonl/);
  assert.match(page, /importListingCreatedAckFile/);
  assert.match(source, /export async function exportJsonl/);
  assert.match(source, /export async function importAckJsonl/);
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|WebSocket/);
});

test('ack before deletion is prohibited and exact identity is required', () => {
  assert.match(source, /row\.send_status = 'acknowledged'/);
  assert.match(source, /row\.acknowledged_at = ack\.acknowledged_at/);
  assert.match(source, /event_id.*local_event_id.*payload_sha256/);
  assert.doesNotMatch(source, /delete\(row\.local_event_id\)|delete\(ack\.local_event_id\)/);
});

test('UUIDv7 format and version are correct', () => {
  const id = uuidv7(1778323200000);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('unstable tenant is rejected', async () => {
  await assert.rejects(
    () => buildListingCreatedEnvelope({
      sourceTenant: 'local-user', inventoryUnitId: boundItem.inventory_unit_id, listingId: 'L1', listingPrice: 0,
    }),
    /source_tenant/,
  );
});
