// shared/validation.js
// The business rules for an incoming order, in ONE place. Both the HTTP
// endpoint and the gRPC handler call validatePlaceOrder(), so they cannot
// drift apart.
//
// Rules:
//   customerRef  optional string, <= 64 chars, [A-Za-z0-9_.-] only
//                (a pseudonymous reference - never a real name, see A1 logging rules)
//   items        required array, 1..50 entries
//   item.name    required non-empty string, <= 100 chars
//   item.price   required finite number, 0 < price <= 10000
//   item.qty     required integer, 1..99
//   idempotencyKey (optional) 1..128 chars of [A-Za-z0-9_.:-]

const { ValidationError } = require('./errors');

const MAX_ITEMS = 50;
const KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const REF_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function validatePlaceOrder(input) {
  const details = [];
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!body) {
    throw new ValidationError('request body must be a JSON object', [
      { field: 'body', issue: 'must be an object' },
    ]);
  }

  let customerRef = 'anonymous';
  if (body.customerRef !== undefined && body.customerRef !== null && body.customerRef !== '') {
    if (typeof body.customerRef !== 'string' || !REF_RE.test(body.customerRef)) {
      details.push({
        field: 'customerRef',
        issue: 'must be 1-64 characters of letters, digits, "_", "." or "-"',
      });
    } else {
      customerRef = body.customerRef;
    }
  }

  const items = [];
  if (!Array.isArray(body.items) || body.items.length === 0) {
    details.push({ field: 'items', issue: 'is required and must be a non-empty array' });
  } else if (body.items.length > MAX_ITEMS) {
    details.push({ field: 'items', issue: `must contain at most ${MAX_ITEMS} items` });
  } else {
    body.items.forEach((raw, i) => {
      const f = (name) => `items[${i}].${name}`;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        details.push({ field: `items[${i}]`, issue: 'must be an object' });
        return;
      }
      const ok = { name: raw.name, price: raw.price, qty: raw.qty };
      let valid = true;
      if (typeof raw.name !== 'string' || raw.name.trim() === '' || raw.name.length > 100) {
        details.push({ field: f('name'), issue: 'must be a non-empty string (max 100 chars)' });
        valid = false;
      }
      if (typeof raw.price !== 'number' || !Number.isFinite(raw.price) || raw.price <= 0 || raw.price > 10000) {
        details.push({ field: f('price'), issue: 'must be a number greater than 0 and at most 10000' });
        valid = false;
      }
      if (!Number.isInteger(raw.qty) || raw.qty < 1 || raw.qty > 99) {
        details.push({ field: f('qty'), issue: 'must be an integer between 1 and 99' });
        valid = false;
      }
      if (valid) items.push({ name: raw.name.trim(), price: raw.price, qty: raw.qty });
    });
  }

  let idempotencyKey = null;
  if (body.idempotencyKey !== undefined && body.idempotencyKey !== null && body.idempotencyKey !== '') {
    if (typeof body.idempotencyKey !== 'string' || !KEY_RE.test(body.idempotencyKey)) {
      details.push({
        field: 'idempotencyKey',
        issue: 'must be 1-128 characters of letters, digits, "_", ".", ":" or "-"',
      });
    } else {
      idempotencyKey = body.idempotencyKey;
    }
  }

  if (details.length > 0) {
    throw new ValidationError('request validation failed', details);
  }

  // Money is handled in integer cents so 0.1 + 0.2 style float errors never reach the DB.
  const amountCents = items.reduce((sum, it) => sum + Math.round(it.price * 100) * it.qty, 0);
  return { customerRef, items, amountCents, idempotencyKey };
}

module.exports = { validatePlaceOrder, MAX_ITEMS };
