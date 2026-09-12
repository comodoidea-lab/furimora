import {
  bindingDecision,
  canonicalJson,
  compareExistingEvent,
  eventKey,
  validateEnvelope,
} from './purchase-inbox-core.js';

const DB_NAME = 'furimora_integration_inbox_v1';
const DB_VERSION = 1;
const STORE_EVENTS = 'events';
const STORE_AUDITS = 'audits';
const STORE_BINDINGS = 'bindings';

const ITEM_FIELDS = [
  'id', 'title', 'images', 'category', 'condition', 'currentPrice', 'startPrice', 'minPrice',
  'costPrice', 'fee', 'shippingCost', 'shippingBaseCost', 'packingCost', 'description',
  'status', 'listedAt', 'discountStartDays', 'discountAmount', 'discountFreqDays',
  'relistCount', 'createdAt', 'priceHistory', 'supplierName', 'purchaseDate',
  'marketplaceId', 'marketplaceName', 'shippingMethodId', 'shippingMethodName',
  'mercariUrl', 'mercariItemId', 'updatedAt', 'soldAt', 'soldPrice', 'soldPriceSource',
  'inventory_unit_id', 'integration',
];

let dbPromise = null;
let context = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_EVENTS)) db.createObjectStore(STORE_EVENTS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_AUDITS)) db.createObjectStore(STORE_AUDITS, { keyPath: 'auditId' });
      if (!db.objectStoreNames.contains(STORE_BINDINGS)) db.createObjectStore(STORE_BINDINGS, { keyPath: 'bindingKey' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Inbox IndexedDBを開けません'));
  });
  return dbPromise;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Inbox IndexedDB操作に失敗しました'));
  });
}

async function getRecord(storeName, key) {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readonly');
  return idbRequest(tx.objectStore(storeName).get(key));
}

async function putRecord(storeName, value) {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(value);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error || new Error('Inbox IndexedDB保存に失敗しました'));
    tx.onabort = () => reject(tx.error || new Error('Inbox IndexedDB保存が中断されました'));
  });
}

async function getAllRecords(storeName) {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readonly');
  return idbRequest(tx.objectStore(storeName).getAll());
}

function nowIso() {
  return new Date().toISOString();
}

function projectItem(item, inventoryUnitId, integration) {
  const out = {};
  for (const field of ITEM_FIELDS) {
    if (field === 'inventory_unit_id' || field === 'integration') continue;
    if (Object.prototype.hasOwnProperty.call(item || {}, field)) out[field] = item[field];
  }
  out.inventory_unit_id = inventoryUnitId;
  out.integration = integration;
  return out;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function payloadHash(payload) {
  return sha256Hex(canonicalJson(payload));
}

function assertContext() {
  if (!context) throw new Error('Furimora Inboxが初期化されていません');
  return context;
}

function getCloudRefs(userId, eventRecord, itemId) {
  const c = assertContext();
  if (typeof c.getCloudRefs !== 'function') throw new Error('Firestore参照が設定されていません');
  return c.getCloudRefs(userId, eventRecord, itemId);
}

async function writeInboxToCloud(record) {
  const c = assertContext();
  const user = c.getUser?.();
  const firestore = c.getFirestore?.();
  if (!user?.uid || !firestore) return { ok: false, reason: 'not_ready' };
  const refs = getCloudRefs(user.uid, record, null);
  const cloudRow = {
    ownerUid: user.uid,
    key: record.key,
    binding_doc_id: refs.claimRef.id,
    event_id: record.event_id || null,
    event_type: record.event_type || null,
    source_system: record.source_system || null,
    source_tenant: record.source_tenant || null,
    inventory_unit_id: record.inventory_unit_id || null,
    occurred_at: record.occurred_at || null,
    schema_version: record.schema_version ?? null,
    payload: record.payload || null,
    payload_sha256: record.payload_sha256 || null,
    raw_envelope: record.raw_envelope || null,
    conflicts: record.conflicts || [],
    status: record.status,
    conflict_reason: record.conflict_reason || null,
    quarantine_reason: record.quarantine_reason || null,
    bound_item_id: record.bound_item_id || null,
    received_at: record.received_at,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  await firestore.runTransaction(async (tx) => {
    const snapshot = await tx.get(refs.inboxRef);
    const existing = snapshot.exists ? snapshot.data() : null;
    // A replay from a stale/offline client must never move a bound or conflict
    // record back to received/quarantined. The local record remains durable.
    if (existing?.status === 'bound' && record.status !== 'bound') return;
    if (existing?.status === 'conflict' && record.status !== 'conflict') return;
    const hashConflict = existing?.payload_sha256
      && record.payload_sha256
      && String(existing.payload_sha256).toLowerCase() !== String(record.payload_sha256).toLowerCase();
    if (hashConflict) {
      // Keep the first payload/hash immutable in the cloud row; append the
      // later payload as conflict evidence instead of violating the rule.
      if (record.status !== 'conflict') return;
      tx.set(refs.inboxRef, {
        ...cloudRow,
        event_id: existing.event_id,
        event_type: existing.event_type,
        source_system: existing.source_system,
        source_tenant: existing.source_tenant,
        inventory_unit_id: existing.inventory_unit_id,
        payload: existing.payload,
        payload_sha256: existing.payload_sha256,
        conflicts: [...(existing.conflicts || []), ...(record.conflicts || [])],
        status: 'conflict',
      }, { merge: true });
      return;
    }
    tx.set(refs.inboxRef, cloudRow, { merge: true });
  });
  return { ok: true };
}

async function createAudit(entry) {
  const audit = {
    auditId: entry.auditId || `inbox_audit_${crypto.randomUUID()}`,
    kind: entry.kind || 'inbox',
    sourceEventId: entry.sourceEventId || null,
    sourceTenant: entry.sourceTenant || null,
    inventoryUnitId: entry.inventoryUnitId || null,
    resolutionId: entry.resolutionId || null,
    statusBefore: entry.statusBefore || null,
    statusAfter: entry.statusAfter || null,
    action: entry.action || null,
    at: entry.at || nowIso(),
    actorUid: entry.actorUid || context?.getUser?.()?.uid || null,
    reason: entry.reason || null,
  };
  await putRecord(STORE_AUDITS, audit);
  const c = context;
  const user = c?.getUser?.();
  const firestore = c?.getFirestore?.();
  if (user?.uid && firestore && typeof c?.getCloudRefs === 'function') {
    const refs = c.getCloudRefs(user.uid, {
      key: audit.sourceEventId ? `${audit.sourceTenant || ''}:${audit.sourceEventId}` : audit.auditId,
      source_tenant: audit.sourceTenant,
      inventory_unit_id: audit.inventoryUnitId,
    }, null);
    await refs.auditRef.set({
      ownerUid: user.uid,
      auditId: audit.auditId,
      kind: audit.kind,
      sourceEventId: audit.sourceEventId,
      sourceTenant: audit.sourceTenant,
      inventoryUnitId: audit.inventoryUnitId,
      resolutionId: audit.resolutionId,
      statusBefore: audit.statusBefore,
      statusAfter: audit.statusAfter,
      action: audit.action,
      at: audit.at,
      actorUid: audit.actorUid,
      reason: audit.reason,
    }).catch(() => {});
  }
  return audit;
}

async function quarantineLine(rawLine, reason, parsed = null) {
  const lineHash = await sha256Hex(rawLine);
  const key = `quarantine:${lineHash}`;
  const record = {
    key,
    status: 'quarantined',
    raw_envelope: String(rawLine),
    event_id: parsed?.event_id || null,
    event_type: parsed?.event_type || null,
    source_system: parsed?.source_system || null,
    source_tenant: parsed?.source_tenant || null,
    inventory_unit_id: parsed?.inventory_unit_id || null,
    payload_sha256: parsed?.payload_sha256 || null,
    quarantine_reason: reason,
    received_at: nowIso(),
  };
  await putRecord(STORE_EVENTS, record);
  await createAudit({
    kind: 'quarantine',
    sourceEventId: parsed?.event_id || null,
    sourceTenant: parsed?.source_tenant || null,
    inventoryUnitId: parsed?.inventory_unit_id || null,
    statusBefore: 'unreceived',
    statusAfter: 'quarantined',
    action: 'import',
    reason,
  });
  await writeInboxToCloud(record).catch(() => {});
  return { result: 'quarantined', key, reason };
}

async function importEnvelope(envelope, rawLine) {
  const validation = validateEnvelope(envelope);
  if (!validation.ok) return quarantineLine(rawLine, validation.errors.join(','), envelope);
  const actualHash = await payloadHash(envelope.payload);
  if (actualHash.toLowerCase() !== String(envelope.payload_sha256).toLowerCase()) {
    return quarantineLine(rawLine, 'payload_hash_mismatch', envelope);
  }

  const key = eventKey(envelope);
  const existing = await getRecord(STORE_EVENTS, key);
  const duplicateState = compareExistingEvent(existing, envelope.payload_sha256);
  if (duplicateState === 'duplicate') {
    await createAudit({
      kind: 'duplicate',
      sourceEventId: envelope.event_id,
      sourceTenant: envelope.source_tenant,
      inventoryUnitId: envelope.inventory_unit_id,
      statusBefore: existing.status,
      statusAfter: existing.status,
      action: 'import_noop',
      reason: 'same_event_same_payload',
    });
    return { result: 'duplicate', key };
  }
  if (duplicateState === 'conflict') {
    const conflict = {
      ...existing,
      status: 'conflict',
      conflict_reason: 'same_event_different_payload',
      conflicts: [...(existing.conflicts || []), {
        raw_envelope: rawLine,
        payload_sha256: envelope.payload_sha256,
        received_at: nowIso(),
      }],
      updated_at: nowIso(),
    };
    await putRecord(STORE_EVENTS, conflict);
    await createAudit({
      kind: 'conflict',
      sourceEventId: envelope.event_id,
      sourceTenant: envelope.source_tenant,
      inventoryUnitId: envelope.inventory_unit_id,
      statusBefore: existing.status,
      statusAfter: 'conflict',
      action: 'import_isolate',
      reason: 'same_event_different_payload',
    });
    await writeInboxToCloud(conflict).catch(() => {});
    return { result: 'conflict', key };
  }

  const record = {
    key,
    status: 'received',
    event_id: envelope.event_id,
    event_type: envelope.event_type,
    source_system: envelope.source_system,
    source_tenant: envelope.source_tenant,
    inventory_unit_id: envelope.inventory_unit_id,
    occurred_at: envelope.occurred_at,
    schema_version: envelope.schema_version,
    payload: envelope.payload,
    payload_sha256: envelope.payload_sha256,
    raw_envelope: rawLine,
    received_at: existing?.received_at || nowIso(),
    updated_at: nowIso(),
  };
  await putRecord(STORE_EVENTS, record);
  await createAudit({
    kind: 'accepted',
    sourceEventId: envelope.event_id,
    sourceTenant: envelope.source_tenant,
    inventoryUnitId: envelope.inventory_unit_id,
    statusBefore: existing?.status || 'unreceived',
    statusAfter: 'received',
    action: 'import',
  });
  await writeInboxToCloud(record).catch(() => {});
  return { result: 'accepted', key };
}

export async function importJsonl(text) {
  const results = [];
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const rawLine of lines) {
    let envelope;
    try {
      envelope = JSON.parse(rawLine);
    } catch {
      results.push(await quarantineLine(rawLine, 'invalid_json'));
      continue;
    }
    results.push(await importEnvelope(envelope, rawLine));
  }
  context?.onChanged?.();
  return results;
}

async function bindCloud(record, itemId) {
  const c = assertContext();
  const user = c.getUser?.();
  const firestore = c.getFirestore?.();
  if (navigator.onLine === false) throw new Error('オフライン中はbindを確定できません');
  if (!user?.uid || !firestore) throw new Error('ログインとFirestore接続が必要です');
  if (!record || record.status !== 'received') {
    if (record?.status === 'bound' && String(record.bound_item_id) === String(itemId)) return { result: 'duplicate' };
    throw new Error(`このInboxイベントはbindできません（status=${record?.status || 'unknown'}）`);
  }
  const item = c.getItemById?.(itemId);
  if (!item) throw new Error('bind対象の商品が見つかりません');
  const refs = getCloudRefs(user.uid, record, itemId);
  const now = nowIso();
  const integration = {
    source_tenant: record.source_tenant,
    purchase_confirmed_event_id: record.event_id,
    binding_doc_id: refs.claimRef.id,
    bound_at: now,
    bound_by: user.uid,
  };
  let decision = 'bind';
  await firestore.runTransaction(async (tx) => {
    const claimSnap = await tx.get(refs.claimRef);
    const itemSnap = await tx.get(refs.itemRef);
    const inboxSnap = await tx.get(refs.inboxRef);
    const claim = claimSnap.exists ? claimSnap.data() : null;
    const remoteRow = itemSnap.exists ? itemSnap.data() : null;
    const remoteItem = remoteRow?.payload || item;
    decision = bindingDecision(claim, remoteItem, record.inventory_unit_id, itemId);
    if (decision === 'duplicate') return;
    if (decision === 'unit_conflict') throw new Error('このinventory_unit_idは別の商品へbind済みです');
    if (decision === 'item_conflict') throw new Error('対象商品には別のinventory_unit_idが設定済みです');
    if (!itemSnap.exists) throw new Error('bind対象商品がFirestoreへ同期されていません');
    if (claim && String(claim.ownerUid) !== String(user.uid)) throw new Error('Unit claimの所有者が一致しません');
    if (inboxSnap.exists && inboxSnap.data()?.status === 'bound') {
      if (String(inboxSnap.data()?.bound_item_id) === String(itemId)) {
        decision = 'duplicate';
        return;
      }
      throw new Error('Inboxイベントは別の商品へbind済みです');
    }
    const updatedItem = projectItem(remoteItem, record.inventory_unit_id, integration);
    if (!claim) {
      tx.set(refs.claimRef, {
        ownerUid: user.uid,
        sourceTenant: record.source_tenant,
        inventoryUnitId: record.inventory_unit_id,
        itemId: String(itemId),
        sourceEventId: record.event_id,
        boundAt: now,
        boundBy: user.uid,
      });
    }
    tx.set(refs.itemRef, {
      itemId: String(itemId),
      payload: updatedItem,
      deleted: false,
      clientUpdatedAt: now,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(refs.inboxRef, {
      ownerUid: user.uid,
      key: record.key,
      binding_doc_id: refs.claimRef.id,
      event_id: record.event_id,
      event_type: record.event_type,
      source_system: record.source_system,
      source_tenant: record.source_tenant,
      inventory_unit_id: record.inventory_unit_id,
      occurred_at: record.occurred_at,
      schema_version: record.schema_version,
      payload: record.payload,
      payload_sha256: record.payload_sha256,
      raw_envelope: record.raw_envelope,
      status: 'bound',
      bound_item_id: String(itemId),
      bound_at: now,
      bound_by: user.uid,
      received_at: record.received_at || now,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  if (decision === 'duplicate') return { result: 'duplicate' };
  await putRecord(STORE_EVENTS, {
    ...record,
    status: 'bound',
    bound_item_id: String(itemId),
    bound_at: now,
    bound_by: user.uid,
    updated_at: now,
  });
  await putRecord(STORE_BINDINGS, {
    bindingKey: `${record.source_tenant}:${record.inventory_unit_id}`,
    source_tenant: record.source_tenant,
    inventory_unit_id: record.inventory_unit_id,
    event_id: record.event_id,
    item_id: String(itemId),
    bound_at: now,
    bound_by: user.uid,
  });
  await createAudit({
    kind: 'bind',
    sourceEventId: record.event_id,
    sourceTenant: record.source_tenant,
    inventoryUnitId: record.inventory_unit_id,
    statusBefore: 'received',
    statusAfter: 'bound',
    action: 'explicit_human_bind',
  });
  c.applyItemBinding?.(itemId, record.inventory_unit_id, integration);
  c.onChanged?.();
  return { result: 'bound', itemId: String(itemId) };
}

export async function bindEvent(key, itemId) {
  const record = await getRecord(STORE_EVENTS, key);
  return bindCloud(record, itemId);
}

export async function listInbox() {
  return (await getAllRecords(STORE_EVENTS)).sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')));
}

export async function listAudits() {
  return (await getAllRecords(STORE_AUDITS)).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

export async function pullInbox() {
  const c = assertContext();
  const user = c.getUser?.();
  const firestore = c.getFirestore?.();
  if (!user?.uid || !firestore) return { ok: false, reason: 'not_ready', count: 0 };
  const snapshot = await firestore.collection('purchaseInbox').where('ownerUid', '==', user.uid).get();
  let count = 0;
  for (const doc of snapshot.docs) {
    const remote = doc.data() || {};
    if (!remote.key) continue;
    const local = await getRecord(STORE_EVENTS, remote.key);
    if (local?.status === 'conflict' && remote.status !== 'conflict') continue;
    if (local?.status === 'bound' && remote.status !== 'bound') continue;
    await putRecord(STORE_EVENTS, {
      ...local,
      ...remote,
      key: remote.key,
      received_at: remote.received_at || local?.received_at || nowIso(),
      updated_at: nowIso(),
    });
    count += 1;
  }
  context?.onChanged?.();
  return { ok: true, count };
}

export async function flushInbox() {
  // A stale local record must not overwrite a newer cloud status (especially bound).
  // Pull is best-effort: local delivery remains durable even when Firestore is unavailable.
  await pullInbox().catch(() => {});
  const records = await listInbox();
  const results = [];
  for (const record of records) results.push(await writeInboxToCloud(record).catch((error) => ({ ok: false, error: error.message })));
  return results;
}

export function init(options) {
  context = options || {};
  return openDb();
}

window.FurimoraPurchaseInbox = {
  init,
  importJsonl,
  bindEvent,
  listInbox,
  listAudits,
  pullInbox,
  flushInbox,
  canonicalJson,
  validateEnvelope,
};
