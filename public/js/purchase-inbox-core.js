const REQUIRED_FIELDS = [
  'event_id',
  'event_type',
  'source_system',
  'source_tenant',
  'inventory_unit_id',
  'occurred_at',
  'schema_version',
  'payload',
  'payload_sha256',
];

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

export function eventKey(envelope) {
  return `${String(envelope?.source_tenant || '')}:${String(envelope?.event_id || '')}`;
}

export function bindingKey(envelope) {
  return `${String(envelope?.source_tenant || '')}:${String(envelope?.inventory_unit_id || '')}`;
}

export function validateEnvelope(envelope) {
  const errors = [];
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, errors: ['envelope_not_object'] };
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in envelope)) errors.push(`missing_${field}`);
  }
  if (envelope.event_type !== 'purchase_confirmed') errors.push('unsupported_event_type');
  if (typeof envelope.event_id !== 'string' || !envelope.event_id.trim()) errors.push('invalid_event_id');
  if (typeof envelope.source_system !== 'string' || !envelope.source_system.trim()) errors.push('invalid_source_system');
  if (typeof envelope.source_tenant !== 'string' || !envelope.source_tenant.trim()) errors.push('invalid_source_tenant');
  if (envelope.source_tenant === 'local-user' || /^firebase[:_]/i.test(String(envelope.source_tenant || ''))) {
    errors.push('unstable_source_tenant');
  }
  if (typeof envelope.inventory_unit_id !== 'string' || !envelope.inventory_unit_id.trim()) {
    errors.push('invalid_inventory_unit_id');
  }
  if (typeof envelope.occurred_at !== 'string' || Number.isNaN(Date.parse(envelope.occurred_at))) {
    errors.push('invalid_occurred_at');
  }
  if (!(typeof envelope.schema_version === 'string' || Number.isInteger(envelope.schema_version))) {
    errors.push('invalid_schema_version');
  }
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
    errors.push('invalid_payload');
  }
  if (!/^[0-9a-f]{64}$/i.test(String(envelope.payload_sha256 || ''))) {
    errors.push('invalid_payload_sha256');
  }
  return { ok: errors.length === 0, errors };
}

export function compareExistingEvent(existing, incomingHash) {
  if (!existing) return 'accepted';
  if (String(existing.payload_sha256).toLowerCase() === String(incomingHash).toLowerCase()) return 'duplicate';
  return 'conflict';
}

export function bindingDecision(existingClaim, item, unitId, itemId) {
  if (existingClaim && String(existingClaim.itemId) !== String(itemId)) return 'unit_conflict';
  if (item?.inventory_unit_id && String(item.inventory_unit_id) !== String(unitId)) return 'item_conflict';
  if (existingClaim && String(existingClaim.itemId) === String(itemId)) {
    return item?.inventory_unit_id ? 'duplicate' : 'repair';
  }
  return 'bind';
}

export { REQUIRED_FIELDS };
