// plan-end-date.test.mjs
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Date:    2026-11-18
// Deploy:  Local only: `npm test`. Never pasted into HubSpot.
// What:    Runs the workflow action in a sandbox with Stripe faked and the clock
//          frozen, so the end-date math and every early exit can be checked without
//          a Stripe or HubSpot account.
// Why:     The end date decides how many times a customer is charged. An off-by-one
//          here means one payment too many or one too few.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import querystring from 'node:querystring';

const SOURCE = readFileSync(new URL('../workflow-action/payment-plan-end-date.js', import.meta.url), 'utf8');

// Frozen "now": 2030-01-01T00:00:00Z. Every fixture is relative to it, so nothing goes stale.
const NOW = Date.UTC(2030, 0, 1) / 1000;
const DAY = 86400;

class FrozenDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW * 1000])); }
  static now() { return NOW * 1000; }
}

function sub(productName, recurring, extra = {}) {
  return {
    id: 'sub_TEST123', status: 'active', billing_cycle_anchor: NOW, metadata: {}, cancel_at: null, schedule: null,
    items: { data: [{ price: { recurring, product: { name: productName } } }] },
    ...extra,
  };
}

async function run({ subscription, piId = 'pi_TEST123', invoice = 'in_TEST123', env = { Stripe_Subscription_End: 'rk_test_placeholder' }, invoiceSub = 'sub_TEST123' }) {
  const posts = [];
  const gets = [];
  const axios = {
    get: async (url) => {
      gets.push(url);
      if (url.includes('/payment_intents/')) return { data: { invoice } };
      if (url.includes('/invoices/')) return { data: { subscription: invoiceSub } };
      if (url.includes('/subscriptions/')) return { data: subscription };
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url, body, opts) => { posts.push({ url, body: querystring.parse(body), headers: opts.headers }); return { data: {} }; },
  };
  const ctx = {
    exports: {},
    require: (name) => (name === 'axios' ? axios : name === 'querystring' ? querystring : null),
    process: { env },
    console: { log() {}, error() {} },
    Date: FrozenDate,
    Math, String, Number, parseInt,
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  const res = await ctx.exports.main({ inputFields: { piId } });
  return { out: JSON.parse(JSON.stringify(res.outputFields)), posts, gets };
}

const iso = (unix) => new Date(unix * 1000).toISOString();
const every14Days = { interval: 'day', interval_count: 14 };
const monthly = { interval: 'month', interval_count: 1 };

test('2 payments every 14 days: ends on day 28, before a third charge', async () => {
  const { out, posts } = await run({ subscription: sub('Workshop: Payment Plan', every14Days) });
  assert.equal(out.result, 'SET');
  assert.equal(out.cancelAt, iso(NOW + 28 * DAY));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.cancel_at, String(NOW + 28 * DAY));
  assert.equal(posts[0].body.proration_behavior, 'none');
  assert.match(posts[0].headers['Idempotency-Key'], /^plan-end-sub_TEST123-/);
});

test('3 monthly payments: ends on the same day 3 months later', async () => {
  const { out } = await run({ subscription: sub('Course: Payment Plan', monthly) });
  assert.equal(out.result, 'SET');
  assert.equal(out.cancelAt, '2030-04-01T00:00:00.000Z');
});

test('month-end anchor is clamped like Stripe (Jan 31 + 1 month = Feb 28)', async () => {
  const jan31 = Date.UTC(2030, 0, 31, 15, 30) / 1000;
  const { out } = await run({ subscription: sub('Course: Payment Plan', monthly, { billing_cycle_anchor: jan31, metadata: { total_payments: '1' } }) });
  assert.equal(out.cancelAt, '2030-02-28T15:30:00.000Z');
});

test('metadata total_payments overrides the plan default', async () => {
  const { out } = await run({ subscription: sub('Workshop: Payment Plan', every14Days, { metadata: { total_payments: '4' } }) });
  assert.equal(out.cancelAt, iso(NOW + 56 * DAY));
  assert.match(out.detail, /4 payments/);
});

test('yearly interval works', async () => {
  const { out } = await run({ subscription: sub('Course: Payment Plan', { interval: 'year', interval_count: 1 }, { metadata: { total_payments: '2' } }) });
  assert.equal(out.cancelAt, '2032-01-01T00:00:00.000Z');
});

test('a product that is not a listed plan is skipped and nothing is written', async () => {
  const { out, posts } = await run({ subscription: sub('Membership - Monthly', monthly) });
  assert.equal(out.result, 'SKIPPED');
  assert.match(out.detail, /not a listed payment plan/);
  assert.equal(posts.length, 0);
});

test('an existing end date is left alone', async () => {
  const { out, posts } = await run({ subscription: sub('Course: Payment Plan', monthly, { cancel_at: NOW + 100 * DAY }) });
  assert.equal(out.result, 'ALREADY_SET');
  assert.equal(posts.length, 0);
});

test('a subscription schedule is left alone', async () => {
  const { out, posts } = await run({ subscription: sub('Course: Payment Plan', monthly, { schedule: 'sub_sched_TEST' }) });
  assert.equal(out.result, 'ALREADY_SET');
  assert.equal(posts.length, 0);
});

test('a cancelled subscription is skipped', async () => {
  const { out, posts } = await run({ subscription: sub('Course: Payment Plan', monthly, { status: 'canceled' }) });
  assert.equal(out.result, 'SKIPPED');
  assert.equal(posts.length, 0);
});

test('an end date already in the past is an error, not a write', async () => {
  const old = NOW - 400 * DAY;
  const { out, posts } = await run({ subscription: sub('Course: Payment Plan', monthly, { billing_cycle_anchor: old }) });
  assert.equal(out.result, 'ERROR');
  assert.match(out.detail, /in the past/);
  assert.equal(posts.length, 0);
});

test('a payment with no invoice (one-time purchase) is skipped', async () => {
  const { out, gets } = await run({ subscription: sub('Course: Payment Plan', monthly), invoice: null });
  assert.equal(out.result, 'SKIPPED');
  assert.equal(gets.length, 1);
});

test('an id that is not a PaymentIntent is skipped without calling Stripe', async () => {
  const { out, gets } = await run({ subscription: sub('Course: Payment Plan', monthly), piId: 'cs_TEST123' });
  assert.equal(out.result, 'SKIPPED');
  assert.equal(gets.length, 0);
});

test('a missing secret is reported as an error', async () => {
  const { out, gets } = await run({ subscription: sub('Course: Payment Plan', monthly), env: {} });
  assert.equal(out.result, 'ERROR');
  assert.match(out.detail, /Stripe_Subscription_End/);
  assert.equal(gets.length, 0);
});
