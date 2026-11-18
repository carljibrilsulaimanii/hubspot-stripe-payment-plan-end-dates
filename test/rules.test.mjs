// rules.test.mjs
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Date:    2026-11-18
// Deploy:  Local only: `npm test`. Never pasted into HubSpot.
// What:    Runs the two rules-table actions (set-end-date-from-rules.js and
//          daily-check.js) in a sandbox with Stripe and HubSpot faked and the clock
//          frozen: rule lookup, draft rules, report-only vs write mode, renewals,
//          other apps' subscriptions, mismatches, overpaid and overdue plans.
// Why:     These actions decide whether a customer is charged again. Every branch is
//          checked without a Stripe or HubSpot account.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import querystring from 'node:querystring';

const OBJ = '2-12345678';
const raw = (f) => readFileSync(new URL(`../workflow-action/rules/${f}`, import.meta.url), 'utf8');
const configured = (src) => src.replace("'REPLACE_WITH_CONFIG_OBJECT_TYPE_ID'", `'${OBJ}'`);
const SET_SRC = raw('set-end-date-from-rules.js');
const CHECK_SRC = raw('daily-check.js');

const NOW = Date.UTC(2030, 0, 1) / 1000;
const DAY = 86400;
class FrozenDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW * 1000])); }
  static now() { return NOW * 1000; }
}
const iso = (unix) => new Date(unix * 1000).toISOString();
const ENV = { Stripe_Subscription_End: 'rk_test_placeholder', Payment_Rules_Token: 'pat-test-placeholder' };

// A tiny fake of the Stripe and HubSpot endpoints the actions call.
function fakeAxios({ subscriptions = {}, rules = [], global = null, invoices = {}, priceSubs = {} }) {
  const calls = { stripePosts: [], created: [], searches: [] };
  const matchRule = (filters) => {
    const f = Object.fromEntries(filters.map((x) => [x.propertyName, x.value]));
    if (f.record_type === 'global') return global ? [global] : [];
    return rules.filter((r) => Object.entries(f).every(([k, v]) => String(r.properties[k]) === String(v)));
  };
  const axios = {
    get: async (url) => {
      const u = new URL(url);
      if (u.pathname.startsWith('/v1/subscriptions/')) return { data: subscriptions[u.pathname.split('/').pop()] };
      if (u.pathname === '/v1/subscriptions') return { data: { data: priceSubs[u.searchParams.get('price')] || [], has_more: false } };
      if (u.pathname === '/v1/invoices') return { data: { data: invoices[u.searchParams.get('subscription')] || [] } };
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url, body) => {
      if (url.startsWith('https://api.stripe.com/v1/subscriptions/')) {
        calls.stripePosts.push({ id: url.split('/').pop(), body: { ...querystring.parse(body) } });
        return { data: {} };
      }
      if (url.endsWith(`/crm/v3/objects/${OBJ}/search`)) {
        calls.searches.push(body.filterGroups[0].filters);
        return { data: { results: matchRule(body.filterGroups[0].filters) } };
      }
      if (url.endsWith(`/crm/v3/objects/${OBJ}`)) {
        calls.created.push(body.properties);
        return { data: { id: '9001' } };
      }
      throw new Error(`unexpected POST ${url}`);
    },
  };
  return { axios, calls };
}

async function run(src, inputFields, fake, env = ENV) {
  const ctx = {
    exports: {},
    require: (n) => (n === 'axios' ? fake.axios : n === 'querystring' ? querystring : null),
    process: { env }, console: { log() {}, error() {} }, Date: FrozenDate, Math, String, Number, parseInt, URL,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const res = await ctx.exports.main({ inputFields });
  return JSON.parse(JSON.stringify(res.outputFields));
}

const rule = (id, props) => ({ id, properties: { record_type: 'product', active: 'true', needs_setup: 'false', ...props } });
const sub = (id, priceId, recurring, extra = {}) => ({
  id, status: 'active', billing_cycle_anchor: NOW, metadata: {}, cancel_at: null, schedule: null, application: null,
  items: { data: [{ price: { id: priceId, recurring, product: { id: 'prod_TEST1', name: 'Course: Payment Plan' } } }] },
  ...extra,
});
const every14 = { interval: 'day', interval_count: 14 };
const monthly = { interval: 'month', interval_count: 1 };
const GLOBAL_ON = { id: '1', properties: { plan_write_mode: 'on' } };
const GLOBAL_REPORT = { id: '1', properties: { plan_write_mode: 'report_only' } };
const PLAN_RULE = rule('501', { name: 'Course plan', stripe_price_id: 'price_PLAN', plan_type: 'ends', total_payments: '2' });

// ------------------------------------------------------------ set-end-date-from-rules.js

test('rules: write mode on sets the end date from the rule (2 payments every 14 days)', async () => {
  const f = fakeAxios({ subscriptions: { sub_A: sub('sub_A', 'price_PLAN', every14) }, rules: [PLAN_RULE], global: GLOBAL_ON });
  const out = await run(configured(SET_SRC), { subscriptionId: 'sub_A' }, f);
  assert.equal(out.result, 'SET');
  assert.equal(out.cancelAt, iso(NOW + 28 * DAY));
  assert.equal(out.totalPayments, '2');
  assert.equal(out.ruleId, '501');
  assert.deepEqual(f.calls.stripePosts, [{ id: 'sub_A', body: { cancel_at: String(NOW + 28 * DAY), proration_behavior: 'none' } }]);
});

test('rules: report only returns WOULD_SET and writes nothing', async () => {
  const f = fakeAxios({ subscriptions: { sub_A: sub('sub_A', 'price_PLAN', every14) }, rules: [PLAN_RULE], global: GLOBAL_REPORT });
  const out = await run(configured(SET_SRC), { subscriptionId: 'sub_A' }, f);
  assert.equal(out.result, 'WOULD_SET');
  assert.equal(f.calls.stripePosts.length, 0);
});

test('rules: no Global record is treated as report only', async () => {
  const f = fakeAxios({ subscriptions: { sub_A: sub('sub_A', 'price_PLAN', every14) }, rules: [PLAN_RULE], global: null });
  const out = await run(configured(SET_SRC), { subscriptionId: 'sub_A' }, f);
  assert.equal(out.result, 'WOULD_SET');
});

test('rules: subscription metadata total_payments overrides the rule', async () => {
  const f = fakeAxios({ subscriptions: { sub_A: sub('sub_A', 'price_PLAN', monthly, { metadata: { total_payments: '3' } }) }, rules: [PLAN_RULE], global: GLOBAL_ON });
  const out = await run(configured(SET_SRC), { subscriptionId: 'sub_A' }, f);
  assert.equal(out.cancelAt, '2030-04-01T00:00:00.000Z');
  assert.equal(out.totalPayments, '3');
});

test('rules: a price with no rule gets a draft rule and nothing is written to Stripe', async () => {
  const f = fakeAxios({ subscriptions: { sub_B: sub('sub_B', 'price_NEW', monthly) }, rules: [PLAN_RULE], global: GLOBAL_ON });
  const out = await run(configured(SET_SRC), { subscriptionId: 'sub_B' }, f);
  assert.equal(out.result, 'NO_RULE');
  assert.equal(out.ruleId, '9001');
  assert.equal(f.calls.created.length, 1);
  assert.equal(f.calls.created[0].stripe_price_id, 'price_NEW');
  assert.equal(f.calls.created[0].needs_setup, 'true');
  assert.equal(f.calls.stripePosts.length, 0);
});

test('rules: an unfinished rule (needs setup) is not applied', async () => {
  const draft = rule('502', { stripe_price_id: 'price_PLAN', plan_type: 'ends', total_payments: '2', needs_setup: 'true', active: 'false' });
  const f = fakeAxios({ subscriptions: { sub_A: sub('sub_A', 'price_PLAN', every14) }, rules: [draft], global: GLOBAL_ON });
  const out = await run(configured(SET_SRC), { subscriptionId: 'sub_A' }, f);
  assert.equal(out.result, 'NO_RULE');
  assert.equal(f.calls.stripePosts.length, 0);
  assert.equal(f.calls.created.length, 0);
});

test('rules: "renews until cancelled" is left alone', async () => {
  const renew = rule('503', { stripe_price_id: 'price_ANNUAL', plan_type: 'renews' });
  const f = fakeAxios({ subscriptions: { sub_C: sub('sub_C', 'price_ANNUAL', { interval: 'year', interval_count: 1 }) }, rules: [renew], global: GLOBAL_ON });
  const out = await run(configured(SET_SRC), { subscriptionId: 'sub_C' }, f);
  assert.equal(out.result, 'RENEWS');
  assert.equal(f.calls.stripePosts.length, 0);
});

test('rules: a subscription created by another app is skipped before any rule lookup', async () => {
  const f = fakeAxios({ subscriptions: { sub_D: sub('sub_D', 'price_PLAN', monthly, { application: 'ca_TEST' }) }, rules: [PLAN_RULE], global: GLOBAL_ON });
  const out = await run(configured(SET_SRC), { subscriptionId: 'sub_D' }, f);
  assert.equal(out.result, 'SKIPPED');
  assert.equal(f.calls.searches.length, 0);
});

test('rules: an ignored price prefix is skipped', async () => {
  const src = configured(SET_SRC).replace('const IGNORE_PRICE_PREFIXES = [];', "const IGNORE_PRICE_PREFIXES = ['n_999_'];");
  const f = fakeAxios({ subscriptions: { sub_E: sub('sub_E', 'n_999_abc', monthly) }, rules: [], global: GLOBAL_ON });
  const out = await run(src, { subscriptionId: 'sub_E' }, f);
  assert.equal(out.result, 'SKIPPED');
  assert.equal(f.calls.created.length, 0);
});

test('rules: an existing end date or schedule is left alone', async () => {
  for (const extra of [{ cancel_at: NOW + 99 * DAY }, { schedule: 'sub_sched_TEST' }]) {
    const f = fakeAxios({ subscriptions: { sub_A: sub('sub_A', 'price_PLAN', every14, extra) }, rules: [PLAN_RULE], global: GLOBAL_ON });
    const out = await run(configured(SET_SRC), { subscriptionId: 'sub_A' }, f);
    assert.equal(out.result, 'ALREADY_SET');
    assert.equal(f.calls.stripePosts.length, 0);
  }
});

test('rules: an end date already in the past is an error, not a write', async () => {
  const f = fakeAxios({ subscriptions: { sub_A: sub('sub_A', 'price_PLAN', every14, { billing_cycle_anchor: NOW - 100 * DAY }) }, rules: [PLAN_RULE], global: GLOBAL_ON });
  const out = await run(configured(SET_SRC), { subscriptionId: 'sub_A' }, f);
  assert.equal(out.result, 'ERROR');
  assert.equal(f.calls.stripePosts.length, 0);
});

test('rules: the unreplaced config object placeholder stops the action', async () => {
  const f = fakeAxios({});
  const out = await run(SET_SRC, { subscriptionId: 'sub_A' }, f);
  assert.equal(out.result, 'ERROR');
  assert.match(out.detail, /CONFIG_OBJECT/);
});

test('rules: missing HubSpot secret is reported', async () => {
  const out = await run(configured(SET_SRC), { subscriptionId: 'sub_A' }, fakeAxios({}), { Stripe_Subscription_End: 'rk_test_placeholder' });
  assert.equal(out.result, 'ERROR');
  assert.match(out.detail, /Payment_Rules_Token/);
});

// ------------------------------------------------------------ daily-check.js

const paidInvoices = (n) => Array.from({ length: n }, (_, i) => ({ id: `in_${i}`, amount_paid: 50000 }));

test('daily check: write mode sets a missing end date and reports it', async () => {
  const f = fakeAxios({ rules: [PLAN_RULE], priceSubs: { price_PLAN: [sub('sub_A', 'price_PLAN', every14)] }, invoices: { sub_A: paidInvoices(1) } });
  const out = await run(configured(CHECK_SRC), { writeMode: 'on' }, f);
  assert.equal(out.checked, 1);
  assert.equal(out.fixed, 1);
  assert.equal(f.calls.stripePosts[0].body.cancel_at, String(NOW + 28 * DAY));
  assert.match(out.summary, /End date set: sub_A/);
});

test('daily check: report only counts it and writes nothing', async () => {
  const f = fakeAxios({ rules: [PLAN_RULE], priceSubs: { price_PLAN: [sub('sub_A', 'price_PLAN', every14)] }, invoices: { sub_A: paidInvoices(1) } });
  const out = await run(configured(CHECK_SRC), { writeMode: 'report_only' }, f);
  assert.equal(out.wouldFix, 1);
  assert.equal(out.fixed, 0);
  assert.equal(out.issues, 1);
  assert.equal(f.calls.stripePosts.length, 0);
  assert.match(out.summary, /^Report only/);
});

test('daily check: an end date that differs from the rule is reported, never changed', async () => {
  const off = sub('sub_A', 'price_PLAN', every14, { cancel_at: NOW + 42 * DAY });
  const f = fakeAxios({ rules: [PLAN_RULE], priceSubs: { price_PLAN: [off] }, invoices: { sub_A: paidInvoices(1) } });
  const out = await run(configured(CHECK_SRC), { writeMode: 'on' }, f);
  assert.equal(out.mismatches, 1);
  assert.equal(f.calls.stripePosts.length, 0);
  assert.match(out.summary, /Off the rule: sub_A/);
});

test('daily check: more paid invoices than the rule allows is reported as overpaid', async () => {
  const ok = sub('sub_A', 'price_PLAN', every14, { cancel_at: NOW + 28 * DAY });
  const f = fakeAxios({ rules: [PLAN_RULE], priceSubs: { price_PLAN: [ok] }, invoices: { sub_A: paidInvoices(3) } });
  const out = await run(configured(CHECK_SRC), { writeMode: 'on' }, f);
  assert.equal(out.overpaid, 1);
  assert.match(out.summary, /3 paid invoices, rule allows 2/);
});

test('daily check: a plan past its end with no end date is reported as overdue, not set', async () => {
  const late = sub('sub_A', 'price_PLAN', every14, { billing_cycle_anchor: NOW - 60 * DAY });
  const f = fakeAxios({ rules: [PLAN_RULE], priceSubs: { price_PLAN: [late] }, invoices: { sub_A: paidInvoices(2) } });
  const out = await run(configured(CHECK_SRC), { writeMode: 'on' }, f);
  assert.equal(out.overdue, 1);
  assert.equal(f.calls.stripePosts.length, 0);
});

test('daily check: other apps, cancelled and scheduled subscriptions are not checked', async () => {
  const subs = [
    sub('sub_X', 'price_PLAN', every14, { application: 'ca_TEST' }),
    sub('sub_Y', 'price_PLAN', every14, { status: 'canceled' }),
    sub('sub_Z', 'price_PLAN', every14, { schedule: 'sub_sched_TEST' }),
  ];
  const f = fakeAxios({ rules: [PLAN_RULE], priceSubs: { price_PLAN: subs } });
  const out = await run(configured(CHECK_SRC), { writeMode: 'on' }, f);
  assert.equal(out.checked, 0);
  assert.equal(out.issues, 0);
});

test('daily check: rules that need setup are counted and listed', async () => {
  const draft = rule('777', { name: 'New plan', stripe_price_id: 'price_DRAFT', needs_setup: 'true', active: 'false' });
  const f = fakeAxios({ rules: [PLAN_RULE, draft], priceSubs: {} });
  const out = await run(configured(CHECK_SRC), { writeMode: 'on' }, f);
  assert.equal(out.needsSetup, 1);
  assert.match(out.summary, /Needs setup: New plan \(price_DRAFT\)/);
});

test('daily check: the unreplaced config object placeholder stops the run', async () => {
  const out = await run(CHECK_SRC, { writeMode: 'on' }, fakeAxios({}));
  assert.match(out.summary, /^ERROR: Set CONFIG_OBJECT/);
});
