// payment-plan-end-date.js
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Date:    2026-11-18
// Deploy:  HubSpot workflow "Payment plan end date (Stripe)", on the custom object
//          HubSpot's Stripe Data Sync fills with Stripe payments. Data Hub custom
//          code action, Node.js 20.x. See README Step 4.
// What:    When a payment plan payment reaches HubSpot, finds its Stripe subscription
//          and sets cancel_at, so Stripe stops by itself after the last payment.
//          Runs on every plan payment but writes once: a subscription that already
//          has an end date or a schedule is left alone.
//          The payment count comes from the subscription's metadata total_payments
//          when set, else the plan's default in PLANS below.
//          The end date is the moment payment N+1 would be charged:
//          billing anchor + N billing intervals.
// Why:     Stripe Payment Links in subscription mode create plain recurring
//          subscriptions with no end date. A "3 payments" label in metadata is
//          ignored by Stripe, which keeps charging until something cancels.
// Note:    New HubSpot custom code actions may not pass `callback`
//          ("callback is not a function"), so done() returns the outputs and only
//          calls callback when it exists.
// Secret:  Stripe_Subscription_End (Stripe restricted key: Subscriptions write,
//          Invoices read, PaymentIntents read, Products read)
// Inputs:  piId = Stripe payment transaction id (the PaymentIntent id, pi_...)
// Outputs: result (SET / ALREADY_SET / SKIPPED / ERROR), subscriptionId, cancelAt, detail
// ---------------------------------------------------------------------------

const axios = require('axios');
const qs = require('querystring');

// First match wins. `payments` is the default when the subscription has no metadata total_payments.
const PLANS = [
  // Edit this list for your own plans (README Step 3).
  // name:     a label used in the outputs
  // test:     matches the Stripe product name of the plan's recurring price
  // payments: number of payments when the subscription has no metadata total_payments
  { name: 'Course payment plan', test: /course.*payment plan/i, payments: 3 },
  { name: 'Workshop payment plan', test: /workshop.*payment plan/i, payments: 2 },
];

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
  const piId = String(event.inputFields['piId'] || '').trim();
  const done = (result, o = {}) => {
    const response = { outputFields: {
      result,
      subscriptionId: o.sub || '',
      cancelAt: o.cancelAt || '',
      detail: String(o.detail || '').slice(0, 400),
    } };
    if (typeof callback === 'function') callback(response);
    return response;
  };

  const key = process.env.Stripe_Subscription_End;
  if (!key) return done('ERROR', { detail: 'Missing secret Stripe_Subscription_End' });
  if (!piId.startsWith('pi_')) return done('SKIPPED', { detail: `not a payment intent: ${piId}` });

  const headers = { Authorization: `Bearer ${key}`, 'Stripe-Version': '2024-06-20' };
  const get = async (path) => (await axios.get(`https://api.stripe.com/v1${path}`, { headers, timeout: 10000 })).data;

  try {
    const pi = await get(`/payment_intents/${piId}`);
    const invoiceId = typeof pi.invoice === 'string' ? pi.invoice : (pi.invoice && pi.invoice.id);
    if (!invoiceId) return done('SKIPPED', { detail: 'payment has no invoice (not a subscription payment)' });

    const invoice = await get(`/invoices/${invoiceId}`);
    const subId = typeof invoice.subscription === 'string' ? invoice.subscription : (invoice.subscription && invoice.subscription.id);
    if (!subId) return done('SKIPPED', { detail: `invoice ${invoiceId} has no subscription` });

    const sub = await get(`/subscriptions/${subId}?expand[]=items.data.price.product`);
    const items = (sub.items && sub.items.data) || [];
    const names = items.map((i) => (i.price && i.price.product && i.price.product.name) || '');
    let plan = null;
    let item = null;
    for (const p of PLANS) {
      const idx = names.findIndex((n) => p.test.test(n));
      if (idx >= 0) { plan = p; item = items[idx]; break; }
    }
    if (!plan) return done('SKIPPED', { sub: subId, detail: `not a listed payment plan: ${names.join(', ')}` });

    if (sub.cancel_at) return done('ALREADY_SET', { sub: subId, cancelAt: iso(sub.cancel_at), detail: `${plan.name}: end date already set` });
    if (sub.schedule) return done('ALREADY_SET', { sub: subId, detail: `${plan.name}: managed by schedule ${sub.schedule}` });
    if (!['active', 'trialing', 'past_due'].includes(sub.status)) {
      return done('SKIPPED', { sub: subId, detail: `${plan.name}: subscription status is ${sub.status}` });
    }
    const recurring = item.price && item.price.recurring;
    if (!recurring) return done('ERROR', { sub: subId, detail: `${plan.name}: price is not recurring` });

    const payments = parseInt(sub.metadata && sub.metadata.total_payments, 10) || plan.payments;
    // Payment 1 is on the billing anchor, so the subscription ends exactly when payment N+1 would be due.
    const cancelAt = addPeriods(sub.billing_cycle_anchor, recurring, payments);
    if (!cancelAt) return done('ERROR', { sub: subId, detail: `${plan.name}: unexpected billing interval ${recurring.interval}` });
    if (cancelAt <= Math.floor(Date.now() / 1000)) {
      return done('ERROR', { sub: subId, detail: `${plan.name}: computed end ${iso(cancelAt)} is in the past, check by hand` });
    }

    await axios.post(
      `https://api.stripe.com/v1/subscriptions/${subId}`,
      qs.stringify({ cancel_at: cancelAt, proration_behavior: 'none' }),
      { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `plan-end-${subId}-${cancelAt}` }, timeout: 10000 },
    );
    return done('SET', { sub: subId, cancelAt: iso(cancelAt), detail: `${plan.name}: ${payments} payments, ends ${iso(cancelAt)}` });
  } catch (e) {
    const msg = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
    return done('ERROR', { detail: String(msg) });
  }
};
