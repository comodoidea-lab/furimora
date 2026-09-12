const HEX = /^[0-9a-f]{64}$/i;

export const LISTING_CREATED_EVENT_TYPE = 'listing_created';
export const LISTING_CREATED_SCHEMA_VERSION = 'v1';

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.keys(value).sort().reduce((out, key) => {
    if (value[key] !== undefined) out[key] = canonicalize(value[key]);
    return out;
  }, {});
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function payloadSha256(payload) {
  return sha256Hex(canonicalJson(payload));
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** UUIDv7 generator. The timestamp is the only sortable component. */
export function uuidv7(nowMs = Date.now()) {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Math.max(0, Math.floor(nowMs)));
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(timestamp >> BigInt((5 - i) * 8)) & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isBoundItem(item) {
  return Boolean(
    item
    && typeof item.inventory_unit_id === 'string'
    && item.inventory_unit_id.trim()
    && item.integration
    && typeof item.integration === 'object'
    && typeof item.integration.source_tenant === 'string'
    && item.integration.source_tenant.trim()
  );
}

export function normalizeListingPrice(value) {
  if (value === null || value === undefined || value === '') {
    return { amount: null, status: 'unknown', currency: 'JPY' };
  }
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount < 0) throw new Error('listing_priceはnullまたは0以上の整数が必要です');
  return { amount, status: 'known', currency: 'JPY' };
}

export function listingIdFor(uuid = uuidv7()) {
  return `furimora:listing:${uuid}`;
}

export function eventIdFor(uuid = uuidv7()) {
  return `furimora:event:${uuid}`;
}

export function localEventIdFor(uuid = uuidv7()) {
  return `furimora:listing-outbox:${uuid}`;
}

export function confirmationIdFor(uuid = uuidv7()) {
  return `furimora:listing-confirmation:${uuid}`;
}

export function listingEventKey(sourceTenant, eventId) {
  return `${String(sourceTenant)}:${String(eventId)}`;
}

export function validateListingCreatedEnvelope(envelope) {
  const errors = [];
  const required = [
    'event_id', 'event_type', 'source_system', 'source_tenant', 'inventory_unit_id',
    'occurred_at', 'schema_version', 'payload', 'payload_sha256',
  ];
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, errors: ['envelope_not_object'] };
  }
  for (const field of required) if (!(field in envelope)) errors.push(`missing_${field}`);
  if (envelope.event_type !== LISTING_CREATED_EVENT_TYPE) errors.push('unsupported_event_type');
  if (typeof envelope.event_id !== 'string' || !envelope.event_id.trim()) errors.push('invalid_event_id');
  if (typeof envelope.source_system !== 'string' || envelope.source_system !== 'furimora') errors.push('invalid_source_system');
  if (typeof envelope.source_tenant !== 'string' || !envelope.source_tenant.trim()) errors.push('invalid_source_tenant');
  if (envelope.source_tenant === 'local-user' || /^firebase[:_]/i.test(String(envelope.source_tenant || ''))) {
    errors.push('unstable_source_tenant');
  }
  if (typeof envelope.inventory_unit_id !== 'string' || !envelope.inventory_unit_id.trim()) errors.push('invalid_inventory_unit_id');
  if (typeof envelope.occurred_at !== 'string' || Number.isNaN(Date.parse(envelope.occurred_at))) errors.push('invalid_occurred_at');
  if (envelope.schema_version !== LISTING_CREATED_SCHEMA_VERSION) errors.push('unsupported_schema_version');
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) errors.push('invalid_payload');
  if (!envelope.payload?.listing_id || typeof envelope.payload.listing_id !== 'string') errors.push('missing_listing_id');
  if (envelope.payload?.marketplace !== 'mercari') errors.push('unsupported_marketplace');
  const price = envelope.payload?.listing_price;
  if (!price || !Object.prototype.hasOwnProperty.call(price, 'amount')) errors.push('missing_listing_price');
  if (price && price.currency !== 'JPY') errors.push('invalid_listing_price_currency');
  if (price && !['known', 'unknown'].includes(price.status)) errors.push('invalid_listing_price_status');
  if (price && price.status === 'unknown' && price.amount !== null) errors.push('unknown_price_must_be_null');
  if (price && price.status === 'known' && (!Number.isInteger(price.amount) || price.amount < 0)) errors.push('known_price_must_be_nonnegative_integer');
  if (!HEX.test(String(envelope.payload_sha256 || ''))) errors.push('invalid_payload_sha256');
  return { ok: errors.length === 0, errors };
}

export function compareExistingEvent(existing, incomingHash) {
  if (!existing) return 'accepted';
  return String(existing.payload_sha256).toLowerCase() === String(incomingHash).toLowerCase()
    ? 'duplicate'
    : 'conflict';
}

export function chooseConfirmationAction(ledger, { itemId, confirmationId, relist = false }) {
  const rows = Array.isArray(ledger) ? ledger : [];
  const sameOperation = rows.find((row) => row.confirmation_id === confirmationId);
  if (sameOperation) return { result: 'duplicate', existing: sameOperation };
  const itemRows = rows.filter((row) => String(row.item_id) === String(itemId));
  if (!relist && itemRows.length) {
    return { result: 'duplicate', existing: itemRows[0] };
  }
  if (relist && !itemRows.length) {
    return { result: 'conflict', reason: 'relist_requires_existing_listing' };
  }
  return { result: 'accepted' };
}

export function buildListingPayload({ listingId, listingPrice }) {
  if (!listingId || typeof listingId !== 'string') throw new Error('listing_idが必要です');
  return {
    listing_id: listingId,
    marketplace: 'mercari',
    listing_price: normalizeListingPrice(listingPrice),
  };
}

export async function buildListingCreatedEnvelope({
  sourceTenant,
  inventoryUnitId,
  listingId,
  eventId,
  occurredAt = new Date().toISOString(),
  listingPrice,
}) {
  if (!sourceTenant || sourceTenant === 'local-user' || /^firebase[:_]/i.test(String(sourceTenant))) {
    throw new Error('安定したintegration source_tenantが必要です');
  }
  if (!inventoryUnitId) throw new Error('bind済みinventory_unit_idが必要です');
  const payload = buildListingPayload({ listingId, listingPrice });
  return {
    event_id: eventId || eventIdFor(),
    event_type: LISTING_CREATED_EVENT_TYPE,
    source_system: 'furimora',
    source_tenant: String(sourceTenant),
    inventory_unit_id: String(inventoryUnitId),
    occurred_at: occurredAt,
    schema_version: LISTING_CREATED_SCHEMA_VERSION,
    payload,
    payload_sha256: await payloadSha256(payload),
  };
}
