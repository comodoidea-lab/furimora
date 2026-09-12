import {
  buildListingCreatedEnvelope,
  canonicalJson,
  chooseConfirmationAction,
  confirmationIdFor,
  compareExistingEvent,
  eventIdFor,
  isBoundItem,
  listingEventKey,
  listingIdFor,
  localEventIdFor,
  payloadSha256,
  uuidv7,
  validateListingCreatedEnvelope,
} from './listing-created-core.js';

const DB_NAME = 'furimora_listing_created_v1';
const DB_VERSION = 1;
const STORE_LEDGER = 'listing_ledger';
const STORE_OUTBOX = 'outbox';
const STORE_OPERATIONS = 'confirmation_operations';
const STORE_AUDITS = 'audits';

let dbPromise = null;
let context = null;

function nowIso() {
  return new Date().toISOString();
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_LEDGER)) {
        const store = db.createObjectStore(STORE_LEDGER, { keyPath: 'listing_id' });
        store.createIndex('item_id', 'item_id', { unique: false });
        store.createIndex('confirmation_id', 'confirmation_id', { unique: true });
        store.createIndex('event_key', 'event_key', { unique: true });
        store.createIndex('inventory_unit_id', 'inventory_unit_id', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const store = db.createObjectStore(STORE_OUTBOX, { keyPath: 'local_event_id' });
        store.createIndex('event_key', 'event_key', { unique: true });
        store.createIndex('event_id', 'event_id', { unique: false });
        store.createIndex('send_status', 'send_status', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_OPERATIONS)) db.createObjectStore(STORE_OPERATIONS, { keyPath: 'confirmation_id' });
      if (!db.objectStoreNames.contains(STORE_AUDITS)) db.createObjectStore(STORE_AUDITS, { keyPath: 'audit_id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('listing_created IndexedDBを開けません'));
  });
  return dbPromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('listing_created IndexedDB操作に失敗しました'));
  });
}

function transactionComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('listing_created transactionに失敗しました'));
    tx.onabort = () => reject(tx.error || new Error('listing_created transactionが中断されました'));
  });
}

async function getAll(storeName) {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readonly');
  return requestResult(tx.objectStore(storeName).getAll());
}

async function getOne(storeName, key) {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readonly');
  return requestResult(tx.objectStore(storeName).get(key));
}

function assertReady() {
  if (!context) throw new Error('listing_created outboxが初期化されていません');
  return context;
}

function assertStableTenant(value) {
  const tenant = String(value || '').trim();
  if (!tenant || tenant === 'local-user' || /^firebase[:_]/i.test(tenant)) {
    throw new Error('安定したintegration source_tenantが未設定です');
  }
  return tenant;
}

function assertBoundItem(item) {
  if (!isBoundItem(item)) throw new Error('bind済みinventory_unit_idを持つ商品だけ出品成立を記録できます');
  return item;
}

export function newConfirmationId() {
  return confirmationIdFor();
}

export async function hasListingsForItem(itemId) {
  const db = await openDb();
  const tx = db.transaction(STORE_LEDGER, 'readonly');
  const rows = await requestResult(tx.objectStore(STORE_LEDGER).index('item_id').getAll(IDBKeyRange.only(String(itemId))));
  return rows.length > 0;
}

export function isConfigured() {
  try {
    return Boolean(assertStableTenant(context?.integrationTenantId));
  } catch {
    return false;
  }
}

/**
 * Human confirmation is the only entry point. No Mercari boundary is called here.
 * The ledger and outbox are committed in one IndexedDB transaction.
 */
export async function confirmListing({ itemId, confirmationId, relist = false, listingPrice = null, occurredAt = nowIso() }) {
  const c = assertReady();
  const item = assertBoundItem(c.getItemById?.(itemId));
  // The inbound ZaikoBang tenant identifies the binding source. It must never
  // be reused as Furimora's outbound tenant.
  const sourceTenant = assertStableTenant(c.integrationTenantId);
  const confirmation = String(confirmationId || newConfirmationId());

  const envelope = await buildListingCreatedEnvelope({
    sourceTenant,
    inventoryUnitId: item.inventory_unit_id,
    listingId: listingIdFor(),
    eventId: eventIdFor(),
    occurredAt,
    listingPrice,
  });
  const eventKey = listingEventKey(envelope.source_tenant, envelope.event_id);
  const localEventId = localEventIdFor();
  const now = nowIso();
  const ledgerRow = {
    listing_id: envelope.payload.listing_id,
    item_id: String(itemId),
    inventory_unit_id: item.inventory_unit_id,
    source_tenant: envelope.source_tenant,
    event_id: envelope.event_id,
    event_key: eventKey,
    confirmation_id: confirmation,
    relist: Boolean(relist),
    status: 'confirmed',
    occurred_at: envelope.occurred_at,
    listing_price: envelope.payload.listing_price,
    created_at: now,
    envelope,
  };
  const outboxRow = {
    local_event_id: localEventId,
    event_id: envelope.event_id,
    event_key: eventKey,
    inventory_unit_id: envelope.inventory_unit_id,
    event_type: envelope.event_type,
    event_payload: envelope.payload,
    envelope,
    payload_sha256: envelope.payload_sha256,
    created_at: now,
    send_status: 'ready',
    retry_count: 0,
    last_attempt_at: null,
    acknowledged_at: null,
  };

  const db = await openDb();
  const tx = db.transaction([STORE_LEDGER, STORE_OUTBOX, STORE_OPERATIONS, STORE_AUDITS], 'readwrite');
  const ledger = await requestResult(tx.objectStore(STORE_LEDGER).getAll());
  const decision = chooseConfirmationAction(ledger, { itemId, confirmationId: confirmation, relist });
  if (decision.result === 'duplicate') {
    tx.abort();
    return { result: 'duplicate', listing: decision.existing, event: decision.existing?.envelope };
  }
  if (decision.result === 'conflict') {
    tx.abort();
    throw new Error(decision.reason);
  }
  tx.objectStore(STORE_OPERATIONS).put({
    confirmation_id: confirmation,
    item_id: String(itemId),
    relist: Boolean(relist),
    status: 'applied',
    event_id: envelope.event_id,
    listing_id: envelope.payload.listing_id,
    created_at: now,
  });
  tx.objectStore(STORE_LEDGER).put(ledgerRow);
  tx.objectStore(STORE_OUTBOX).put(outboxRow);
  tx.objectStore(STORE_AUDITS).put({
    audit_id: `listing_created_audit:${uuidv7()}`,
    action: 'human_confirmed_listing_created',
    item_id: String(itemId),
    inventory_unit_id: item.inventory_unit_id,
    event_id: envelope.event_id,
    listing_id: envelope.payload.listing_id,
    at: now,
  });
  await transactionComplete(tx);
  c.onChanged?.();
  return { result: 'accepted', listing: ledgerRow, outbox: outboxRow, event: envelope };
}

export async function listLedger() {
  return (await getAll(STORE_LEDGER)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function listOutbox() {
  return (await getAll(STORE_OUTBOX)).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

export async function listAudits() {
  return (await getAll(STORE_AUDITS)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export async function exportJsonl() {
  const rows = await listOutbox();
  return rows.filter((row) => row.send_status !== 'acknowledged')
    .map((row) => canonicalJson(row.envelope))
    .join('\n');
}

export async function markSendAttempt(localEventId) {
  const db = await openDb();
  const tx = db.transaction(STORE_OUTBOX, 'readwrite');
  const store = tx.objectStore(STORE_OUTBOX);
  const row = await requestResult(store.get(localEventId));
  if (!row) throw new Error('outboxイベントが見つかりません');
  if (row.send_status === 'acknowledged') {
    tx.abort();
    return { result: 'duplicate', row };
  }
  row.send_status = 'sent';
  row.retry_count = Number(row.retry_count || 0) + 1;
  row.last_attempt_at = nowIso();
  store.put(row);
  await transactionComplete(tx);
  return { result: 'accepted', row };
}

function parseAckLine(rawLine) {
  let ack;
  try { ack = JSON.parse(rawLine); } catch { throw new Error('invalid_json'); }
  const required = ['event_id', 'local_event_id', 'delivery_id', 'payload_sha256', 'result', 'acknowledged_at', 'error_code'];
  const missing = required.filter((key) => !(key in ack));
  if (missing.length) throw new Error(`missing_${missing.join(',')}`);
  return ack;
}

export async function importAckJsonl(text) {
  const results = [];
  for (const rawLine of String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    try {
      const ack = parseAckLine(rawLine);
      const db = await openDb();
      const tx = db.transaction(STORE_OUTBOX, 'readwrite');
      const store = tx.objectStore(STORE_OUTBOX);
      const row = await requestResult(store.get(ack.local_event_id));
      if (!row) throw new Error('unknown_local_event_id');
      const exact = String(row.event_id) === String(ack.event_id)
        && String(row.local_event_id) === String(ack.local_event_id)
        && String(row.payload_sha256).toLowerCase() === String(ack.payload_sha256).toLowerCase();
      if (!exact) throw new Error('ack_identity_mismatch');
      if (!['accepted', 'duplicate', 'conflict', 'quarantined'].includes(ack.result)) throw new Error('invalid_ack_result');
      if (ack.result === 'accepted' || ack.result === 'duplicate') {
        row.send_status = 'acknowledged';
        row.acknowledged_at = ack.acknowledged_at;
      } else {
        row.send_status = ack.result;
      }
      row.last_ack = {
        event_id: ack.event_id,
        local_event_id: ack.local_event_id,
        delivery_id: ack.delivery_id,
        payload_sha256: ack.payload_sha256,
        result: ack.result,
        acknowledged_at: ack.acknowledged_at,
        error_code: ack.error_code,
      };
      store.put(row);
      await transactionComplete(tx);
      results.push({ result: ack.result === 'accepted' || ack.result === 'duplicate' ? 'acknowledged' : ack.result, local_event_id: row.local_event_id });
    } catch (error) {
      results.push({ result: 'conflict', reason: error.message || String(error) });
    }
  }
  return results;
}

export async function init(options = {}) {
  context = options;
  await openDb();
  return { ok: true };
}

export const __testing = {
  DB_NAME,
  STORE_LEDGER,
  STORE_OUTBOX,
  validateListingCreatedEnvelope,
  compareExistingEvent,
  payloadSha256,
};

window.FurimoraListingCreated = {
  init,
  isConfigured,
  newConfirmationId,
  hasListingsForItem,
  confirmListing,
  listLedger,
  listOutbox,
  listAudits,
  exportJsonl,
  markSendAttempt,
  importAckJsonl,
  validateListingCreatedEnvelope,
};
