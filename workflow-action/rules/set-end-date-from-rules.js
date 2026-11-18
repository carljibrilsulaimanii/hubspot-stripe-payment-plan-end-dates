// set-end-date-from-rules.js
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Date:    2026-11-18
// Deploy:  HubSpot workflow "Payment plans - Set end date", on the custom object
//          HubSpot's Stripe Data Sync fills with Stripe subscriptions. Data Hub
//          custom code action, Node.js 20.x. See README Step 10.
// What:    When a new Stripe subscription reaches HubSpot, looks up its price in the
//          Payment Product Config rules table and, for a plan that ends after N
//          payments, sets the subscription's cancel_at so Stripe stops by itself
//          after the last payment. A price with no rule gets a draft rule to fill in.
//          The payment count comes from the subscription's metadata total_payments
//          when set, else the rule's total_payments.
//          The end date is the moment payment N+1 would be charged:
//          billing anchor + N billing intervals.
// Why:     The code-list version (payment-plan-end-date.js) needs a code change for
//          every new plan. Here the plans live in HubSpot records the team edits.
// Secrets: Stripe_Subscription_End (Stripe restricted key: Subscriptions write,
//          Invoices read, PaymentIntents read, Products read)
//          Payment_Rules_Token (HubSpot service key: crm.objects.custom.read,
//          crm.objects.custom.write)
// Inputs:  subscriptionId = Stripe subscription id (sub_...)
// Outputs: result (SET / WOULD_SET / ALREADY_SET / NO_RULE / RENEWS / IGNORED /
//          SKIPPED / ERROR), subscriptionId, cancelAt, totalPayments, ruleId, detail
// ---------------------------------------------------------------------------

const axios = require('axios');
const qs = require('querystring');

// Object type id of your Payment Product Config object (README Step 7), e.g. 2-12345678.
const CONFIG_OBJECT = 'REPLACE_WITH_CONFIG_OBJECT_TYPE_ID';
// Price id prefixes that belong to another app on your Stripe account and must never be
// touched, e.g. ['n_1234567_'] for a community platform's memberships. Empty = none.
const IGNORE_PRICE_PREFIXES = [];

// Internal values of the dropdown options (README Step 7).
const PLAN_ENDS = 'ends';
const PLAN_RENEWS = 'renews';
const WRITE_ON = 'on';

const HUBSPOT = 'https://api.hubapi.com';
const RULE_PROPS = ['name', 'plan_type', 'total_payments', 'active', 'needs_setup'];

// Same day of the month, n months later, at the same time (clamped to the month's last day like Stripe does).
const addMonths = (unix, n) => {
  const d = new Date(unix * 1000);
  const day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return Math.floor(t.getTime() / 1000);
};
// anchor + n billing periods, for Stripe recurring { interval, interval_count }.
const addPeriods = (unix, recurring, n) => {
  const count = (recurring.interval_count || 1) * n;
  if (recurring.interval === 'month') return addMonths(unix, count);
  if (recurring.interval === 'year') return addMonths(unix, count * 12);
  if (recurring.interval === 'week') return unix + count * 7 * 86400;
  if (recurring.interval === 'day') return unix + count * 86400;
  return null;
};
const iso = (unix) => new Date(unix * 1000).toISOString();

exports.main = async (event, callback) => {
  const subId = String(event.inputFields['subscriptionId'] || '').trim();
  const done = (result, o = {}) => {
    const response = { outputFields: {
      result,
      subscriptionId: subId,
      cancelAt: o.cancelAt || '',
      totalPayments: o.payments ? String(o.payments) : '',
      ruleId: o.ruleId || '',
      detail: String(o.detail || '').slice(0, 400),
    } };
    if (typeof callback === 'function') callback(response);
    return response;
  };

  const stripeKey = process.env.Stripe_Subscription_End;
  const hsToken = process.env.Payment_Rules_Token;
  if (!stripeKey) return done('ERROR', { detail: 'Missing secret Stripe_Subscription_End' });
  if (!hsToken) return done('ERROR', { detail: 'Missing secret Payment_Rules_Token' });
  if (CONFIG_OBJECT.startsWith('REPLACE')) return done('ERROR', { detail: 'Set CONFIG_OBJECT to your config object type id' });
  if (!subId.startsWith('sub_')) return done('SKIPPED', { detail: `not a subscription id: ${subId}` });

  const sHeaders = { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': '2024-06-20' };
  const sget = async (path) => (await axios.get(`https://api.stripe.com/v1${path}`, { headers: sHeaders, timeout: 8000 })).data;
  const hHeaders = { Authorization: `Bearer ${hsToken}`, 'Content-Type': 'application/json' };
  const hpost = async (path, body) => (await axios.post(`${HUBSPOT}${path}`, body, { headers: hHeaders, timeout: 8000 })).data;
  const findOne = async (propertyName, value, properties) => {
    const r = await hpost(`/crm/v3/objects/${CONFIG_OBJECT}/search`, {
      filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }], properties, limit: 1,
    });
    return (r.results && r.results[0]) || null;
  };

  try {
    const sub = await sget(`/subscriptions/${subId}?expand[]=items.data.price.product`);
    if (sub.application) return done('SKIPPED', { detail: `created by another app (${sub.application})` });
    if (!['active', 'trialing', 'past_due'].includes(sub.status)) {
      return done('SKIPPED', { detail: `subscription status is ${sub.status}` });
    }
    const item = ((sub.items && sub.items.data) || []).find((i) => i.price && i.price.recurring);
    if (!item) return done('SKIPPED', { detail: 'no recurring price on the subscription' });
    const price = item.price;
    if (IGNORE_PRICE_PREFIXES.some((p) => price.id.startsWith(p))) {
      return done('SKIPPED', { detail: `price ${price.id} is on the ignore list` });
    }
    const product = price.product || {};
    const productId = typeof product === 'string' ? product : product.id;
    const productName = (typeof product === 'object' && product.name) || price.id;

    const rule = await findOne('stripe_price_id', price.id, RULE_PROPS);
    if (!rule) {
      const draft = await hpost(`/crm/v3/objects/${CONFIG_OBJECT}`, { properties: {
        name: productName, record_type: 'product', stripe_price_id: price.id, stripe_product_id: productId || '',
        needs_setup: 'true', active: 'false',
      } });
      return done('NO_RULE', { ruleId: draft.id, detail: `no rule for ${productName} (${price.id}); draft rule created` });
    }
    const p = rule.properties || {};
    if (p.active !== 'true' || p.needs_setup === 'true') {
      return done('NO_RULE', { ruleId: rule.id, detail: `rule for ${productName} is not finished (active or needs setup)` });
    }
    if (p.plan_type === PLAN_RENEWS) return done('RENEWS', { ruleId: rule.id, detail: `${productName} renews until cancelled` });
    if (p.plan_type !== PLAN_ENDS) return done('IGNORED', { ruleId: rule.id, detail: `${productName}: plan type ${p.plan_type || 'empty'}` });

    if (sub.cancel_at) return done('ALREADY_SET', { ruleId: rule.id, cancelAt: iso(sub.cancel_at), detail: 'end date already set' });
    if (sub.schedule) return done('ALREADY_SET', { ruleId: rule.id, detail: `managed by schedule ${sub.schedule}` });

    const payments = parseInt(sub.metadata && sub.metadata.total_payments, 10) || parseInt(p.total_payments, 10);
    if (!payments || payments < 1) return done('ERROR', { ruleId: rule.id, detail: `${productName}: rule has no number of payments` });
    // Payment 1 is on the billing anchor, so the subscription ends exactly when payment N+1 would be due.
    const cancelAt = addPeriods(sub.billing_cycle_anchor, price.recurring, payments);
    if (!cancelAt) return done('ERROR', { ruleId: rule.id, detail: `unexpected billing interval ${price.recurring.interval}` });
    if (cancelAt <= Math.floor(Date.now() / 1000)) {
      return done('ERROR', { ruleId: rule.id, payments, detail: `computed end ${iso(cancelAt)} is in the past, check by hand` });
    }

    const global = await findOne('record_type', 'global', ['plan_write_mode']);
    const writeOn = !!global && (global.properties || {}).plan_write_mode === WRITE_ON;
    if (!writeOn) {
      return done('WOULD_SET', { ruleId: rule.id, payments, cancelAt: iso(cancelAt), detail: `report only: ${productName}, ${payments} payments, would end ${iso(cancelAt)}` });
    }

    await axios.post(
      `https://api.stripe.com/v1/subscriptions/${subId}`,
      qs.stringify({ cancel_at: cancelAt, proration_behavior: 'none' }),
      { headers: { ...sHeaders, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `plan-end-${subId}-${cancelAt}` }, timeout: 8000 },
    );
    return done('SET', { ruleId: rule.id, payments, cancelAt: iso(cancelAt), detail: `${productName}: ${payments} payments, ends ${iso(cancelAt)}` });
  } catch (e) {
    const msg = (e.response && e.response.data && ((e.response.data.error && e.response.data.error.message) || e.response.data.message)) || e.message;
    return done('ERROR', { detail: String(msg) });
  }
};
