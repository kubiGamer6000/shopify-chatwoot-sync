/**
 * End-to-end verification of the caching / idempotency / audit work.
 * Requires REAL credentials (Firestore, Shopify, Skio, 17track).
 *
 *   npx tsx src/scripts/verifyCaching.ts [email]
 *
 * It prints PASS/FAIL per check and cleans up its own test cache entries.
 */
import { getDb } from '../services/firestore.js';
import {
  cached,
  cacheGet,
  cacheSet,
  cacheDelete,
  claimOnce,
} from '../services/cache.js';
import {
  searchCustomerByEmail,
  fetchCustomerOrders,
  invalidateCustomerCache,
} from '../services/shopify.js';
import { getSubscriptionsByEmail } from '../services/skio.js';
import { getCustomerProfile } from '../services/customerProfile.js';
import { recordAiUsage } from '../services/aiAudit.js';

const TEST_EMAIL = process.argv[2] || 'blesssuer@gmail.com';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('\n=== 1. Firestore connectivity ===');
  const db = getDb();
  check('Firestore initialized (getDb non-null)', db != null);
  if (!db) {
    console.log('\nFirestore is disabled — cannot verify caching. Aborting.');
    process.exit(1);
  }

  console.log('\n=== 2. Generic cache primitives ===');
  await cacheDelete('verify', 'k1');
  let calls = 0;
  const producer = async () => {
    calls++;
    return { n: 42, at: calls };
  };
  const first = await cached('verify', 'k1', 60_000, producer);
  const second = await cached('verify', 'k1', 60_000, producer);
  check('cached() runs producer once (read-through hit)', calls === 1, `producer calls=${calls}`);
  check('cached() returns stable value', first.n === 42 && second.n === 42);

  await cacheSet('verify', 'k2', { hello: 'world' }, 60_000);
  const got = await cacheGet<{ hello: string }>('verify', 'k2');
  check('cacheSet + cacheGet round-trip', got?.hello === 'world');

  await cacheDelete('verify', 'k2');
  const gone = await cacheGet('verify', 'k2');
  check('cacheDelete removes entry', gone === undefined);

  // TTL expiry
  await cacheSet('verify', 'k3', { x: 1 }, -1); // already expired
  const expired = await cacheGet('verify', 'k3');
  check('cacheGet respects TTL expiry', expired === undefined);
  await cacheDelete('verify', 'k3');

  console.log('\n=== 3. Idempotency (claimOnce) ===');
  const key = `verify-${Date.now()}`;
  const claim1 = await claimOnce('verify-claim', key, 60_000);
  const claim2 = await claimOnce('verify-claim', key, 60_000);
  check('First claim succeeds', claim1 === true);
  check('Duplicate claim is rejected', claim2 === false);
  await cacheDelete('verify-claim', key);

  console.log('\n=== 4. Shopify cache (searchCustomerByEmail) ===');
  await invalidateCustomerCache({ email: TEST_EMAIL });
  const t1 = Date.now();
  const cust1 = await searchCustomerByEmail(TEST_EMAIL);
  const cold = Date.now() - t1;
  const t2 = Date.now();
  const cust2 = await searchCustomerByEmail(TEST_EMAIL);
  const warm = Date.now() - t2;
  check(
    'searchCustomerByEmail returns consistent result',
    (cust1?.id ?? null) === (cust2?.id ?? null),
    cust1 ? `customerId=${cust1.id}` : 'no customer for email',
  );
  check('Warm read faster than cold (cache hit)', warm <= cold, `cold=${cold}ms warm=${warm}ms`);

  if (cust1?.id) {
    console.log('\n=== 5. Shopify orders cache ===');
    await invalidateCustomerCache({ customerId: cust1.id });
    const o1s = Date.now();
    const orders1 = await fetchCustomerOrders(cust1.id);
    const oCold = Date.now() - o1s;
    const o2s = Date.now();
    const orders2 = await fetchCustomerOrders(cust1.id);
    const oWarm = Date.now() - o2s;
    check('fetchCustomerOrders consistent count', orders1.length === orders2.length, `orders=${orders1.length}`);
    check('Warm orders read faster (cache hit)', oWarm <= oCold, `cold=${oCold}ms warm=${oWarm}ms`);
  }

  console.log('\n=== 6. Skio subscription cache ===');
  const s1 = Date.now();
  const subs1 = await getSubscriptionsByEmail(TEST_EMAIL);
  const sCold = Date.now() - s1;
  const s2 = Date.now();
  const subs2 = await getSubscriptionsByEmail(TEST_EMAIL);
  const sWarm = Date.now() - s2;
  check('getSubscriptionsByEmail consistent count', subs1.length === subs2.length, `subs=${subs1.length}`);
  check('Warm subs read faster (cache hit)', sWarm <= sCold, `cold=${sCold}ms warm=${sWarm}ms`);

  console.log('\n=== 7. Full customer profile (Shopify + tracking + Skio) ===');
  const p1 = Date.now();
  const prof1 = await getCustomerProfile({ email: TEST_EMAIL });
  const pCold = Date.now() - p1;
  const p2 = Date.now();
  const prof2 = await getCustomerProfile({ email: TEST_EMAIL });
  const pWarm = Date.now() - p2;
  check('getCustomerProfile stable order count', prof1.orders.length === prof2.orders.length, `orders=${prof1.orders.length}`);
  check('Warm profile faster (caches hit)', pWarm <= pCold, `cold=${pCold}ms warm=${pWarm}ms`);

  console.log('\n=== 8. Audit log write (aiUsage) ===');
  await recordAiUsage({ kind: 'verify-test', model: 'test', inputTokens: 1, outputTokens: 1 });
  // Read back the most recent verify-test entry.
  const snap = await db
    .collection('aiUsage')
    .where('kind', '==', 'verify-test')
    .limit(1)
    .get();
  check('aiUsage entry written & readable', !snap.empty);
  // Clean up the test usage docs.
  await Promise.all(snap.docs.map((d) => d.ref.delete()));

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Crashed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
