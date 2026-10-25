// Unit tests for the shared business rules (no database or network needed).
const test = require('node:test');
const assert = require('node:assert');
const { validatePlaceOrder } = require('../validation');
const { ValidationError } = require('../errors');

const good = { customerRef: 'cust_42', items: [{ name: 'Zinger Burger', price: 5.5, qty: 2 }] };

test('valid order is accepted and totalled in integer cents', () => {
  const v = validatePlaceOrder(good);
  assert.strictEqual(v.amountCents, 1100);
  assert.strictEqual(v.customerRef, 'cust_42');
});

test('floating point money does not drift (0.1 + 0.2 style)', () => {
  const v = validatePlaceOrder({ items: [{ name: 'a', price: 0.1, qty: 1 }, { name: 'b', price: 0.2, qty: 1 }] });
  assert.strictEqual(v.amountCents, 30);
});

test('customerRef defaults to anonymous', () => {
  assert.strictEqual(validatePlaceOrder({ items: good.items }).customerRef, 'anonymous');
});

for (const [label, body] of [
  ['non-object body', 'nope'],
  ['missing items', {}],
  ['empty items', { items: [] }],
  ['too many items', { items: Array.from({ length: 51 }, () => good.items[0]) }],
  ['blank name', { items: [{ name: ' ', price: 1, qty: 1 }] }],
  ['zero price', { items: [{ name: 'x', price: 0, qty: 1 }] }],
  ['string price', { items: [{ name: 'x', price: '1', qty: 1 }] }],
  ['NaN price', { items: [{ name: 'x', price: NaN, qty: 1 }] }],
  ['fractional qty', { items: [{ name: 'x', price: 1, qty: 1.5 }] }],
  ['qty 100', { items: [{ name: 'x', price: 1, qty: 100 }] }],
  ['personal-looking customerRef', { customerRef: 'Ali Khan', items: good.items }],
  ['bad idempotency key', { items: good.items, idempotencyKey: 'has spaces' }],
]) {
  test(`rejects: ${label}`, () => {
    assert.throws(() => validatePlaceOrder(body), ValidationError);
  });
}

test('validation errors list every bad field', () => {
  try {
    validatePlaceOrder({ items: [{ name: '', price: -1, qty: 0 }] });
    assert.fail('should throw');
  } catch (err) {
    assert.deepStrictEqual(err.details.map((d) => d.field), ['items[0].name', 'items[0].price', 'items[0].qty']);
  }
});
