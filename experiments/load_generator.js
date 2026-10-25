// load_generator.js
// Sends a steady stream of realistic order requests so Prometheus has
// something to scrape and Grafana has something to draw. Used as the
// "repeatable test" baseline in Part E.1 (before/during/after the fault).
//
// Usage:
//   node load_generator.js [durationSeconds] [requestsPerSecond]
//
// Example: 60 seconds at 5 req/s
//   node load_generator.js 60 5

const { randomUUID } = require('crypto');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const durationSeconds = Number(process.argv[2] || 30);
const rps = Number(process.argv[3] || 5);

const MENU = [
  { name: 'Zinger Burger', price: 5.5 },
  { name: 'Fries', price: 2.0 },
  { name: 'Coke', price: 1.5 },
  { name: 'Chicken Wrap', price: 4.0 },
  { name: 'Milkshake', price: 3.0 },
];

function randomOrderBody() {
  const itemCount = 1 + Math.floor(Math.random() * 3);
  const items = Array.from({ length: itemCount }, () => {
    const menuItem = MENU[Math.floor(Math.random() * MENU.length)];
    return { ...menuItem, qty: 1 + Math.floor(Math.random() * 2) };
  });
  return { customerRef: `cust_${Math.floor(Math.random() * 1000)}`, items };
}

async function placeOrder() {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      // A2: every order carries an Idempotency-Key, like a well-behaved client.
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(randomOrderBody()),
    });
    const order = await res.json();
    const tookMs = Date.now() - start;

    // Occasionally mark it ready shortly after, so order_processing_seconds
    // gets samples too.
    if (order.id && Math.random() > 0.2) {
      setTimeout(() => {
        // A2: POST /orders/:id/ready was replaced by PATCH /orders/:id {status:"ready"}
        fetch(`${BASE_URL}/orders/${order.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'ready' }),
        }).catch(() => {});
      }, 200 + Math.random() * 800);
    }
    return { ok: res.ok, tookMs };
  } catch (err) {
    return { ok: false, error: err.message, tookMs: Date.now() - start };
  }
}

async function main() {
  console.log(`Load generator: ${rps} req/s for ${durationSeconds}s against ${BASE_URL}`);
  const intervalMs = 1000 / rps;
  const endAt = Date.now() + durationSeconds * 1000;
  let sent = 0;
  let ok = 0;
  let failed = 0;
  let totalMs = 0;

  while (Date.now() < endAt) {
    const result = await placeOrder();
    sent += 1;
    totalMs += result.tookMs;
    if (result.ok) ok += 1;
    else failed += 1;

    if (sent % 10 === 0) {
      console.log(`  sent=${sent} ok=${ok} failed=${failed} avgMs=${(totalMs / sent).toFixed(1)}`);
    }
    await sleep(intervalMs);
  }

  console.log(`Done. sent=${sent} ok=${ok} failed=${failed} avgMs=${(totalMs / sent).toFixed(1)}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
