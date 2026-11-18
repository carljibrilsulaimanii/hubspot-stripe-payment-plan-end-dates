// daily-check.js
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Date:    2026-11-18
// Deploy:  HubSpot workflow "Payment plans - Daily check", on the Payment Product
//          Config object, enrolling only the Global record on a daily schedule.
//          Data Hub custom code action, Node.js 20.x. See README Step 11.
// What:    For every active "ends after N payments" rule, lists the live Stripe
//          subscriptions on that price and checks each one:
//            - no end date            -> sets it (write mode On) or counts it (Report only)
//            - end date off the rule  -> reported, never changed
//            - more paid invoices than the rule allows -> reported
//            - should already have ended -> reported
//          Also counts rules still marked "needs setup". Returns one summary for a
//          Slack message and for the Global record.
// Why:     The Set end date workflow can miss a subscription (it was off, a rule was
//          added late, an error). This is the backstop, and the place a team sees
//          that every plan is ending on time.
// Limits:  HubSpot stops custom code after about 20 seconds, so the run stops starting
//          new subscriptions after TIME_BUDGET_MS and reports truncated = true. Run it
//          again (or more often) if that happens.
// Secrets: Stripe_Subscription_End (Stripe restricted key: Subscriptions write,
//          Invoices read, PaymentIntents read, Products read)
//          Payment_Rules_Token (HubSpot service key: crm.objects.custom.read,
//          crm.objects.custom.write)
// Inputs:  writeMode = the Global record's plan_write_mode (on / report_only)
// Outputs: summary, issues, checked, fixed, wouldFix, mismatches, overpaid,
//          overdue, needsSetup, truncated
// ---------------------------------------------------------------------------

const axios = require('axios');
const qs = require('querystring');

// Object type id of your Payment Product Config object (README Step 7), e.g. 2-12345678.
const CONFIG_OBJECT = 'REPLACE_WITH_CONFIG_OBJECT_TYPE_ID';
// Price id prefixes that belong to another app on your Stripe account. Empty = none.
const IGNORE_PRICE_PREFIXES = [];
// Stop starting new work after this long, so the action ends before HubSpot's limit.
const TIME_BUDGET_MS = 14000;

const PLAN_ENDS = 'ends';
const WRITE_ON = 'on';
const LIVE = ['active', 'trialing', 'past_due'];
const HUBSPOT = 'https://api.hubapi.com';

const addMonths = (unix, n) => {
  const d = new Date(unix * 1000);
  const day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return Math.floor(t.getTime() / 1000);
};
const addPeriods = (unix, recurring, n) => {
  const count = (recurring.interval_count || 1) * n;
  if (recurring.interval === 'month') return addMonths(unix, count);
  if (recurring.interval === 'year') return addMonths(unix, count * 12);
  if (recurring.interval === 'week') return unix + count * 7 * 86400;
  if (recurring.interval === 'day') return unix + count * 86400;
  return null;
};
const day = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);

exports.main = async (event, callback) => {
  const started = Date.now();
  const writeOn = String(event.inputFields['writeMode'] || '').trim() === WRITE_ON;
  const stats = { checked: 0, fixed: 0, wouldFix: 0, mismatches: 0, overpaid: 0, overdue: 0, needsSetup: 0 };
  const lines = [];
  let truncated = false;

  const done = (extra = {}) => {
    const issues = stats.mismatches + stats.overpaid + stats.overdue + stats.needsSetup + stats.wouldFix + (extra.error ? 1 : 0);
    const head = extra.error
      ? `ERROR: ${extra.error}`
      : `${writeOn ? 'Write mode' : 'Report only'}: ${stats.checked} plan subscriptions checked, ${stats.fixed} end dates set, ${stats.wouldFix} would be set, ${stats.mismatches} off the rule, ${stats.overpaid} overpaid, ${stats.overdue} past their end, ${stats.needsSetup} rules need setup${truncated ? ' (stopped early: time limit)' : ''}`;
    const summary = [head, ...lines].join('\n').slice(0, 1000);
    const response = { outputFields: {
      summary, issues, ...stats, truncated: truncated ? 'true' : 'false',
    } };
    if (typeof callback === 'function') callback(response);
    return response;
  };

  const stripeKey = process.env.Stripe_Subscription_End;
  const hsToken = process.env.Payment_Rules_Token;
  if (!stripeKey) return done({ error: 'Missing secret Stripe_Subscription_End' });
  if (!hsToken) return done({ error: 'Missing secret Payment_Rules_Token' });
  if (CONFIG_OBJECT.startsWith('REPLACE')) return done({ error: 'Set CONFIG_OBJECT to your config object type id' });

  const sHeaders = { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': '2024-06-20' };
  const sget = async (path, params) => (await axios.get(`https://api.stripe.com/v1${path}?${qs.stringify(params)}`, { headers: sHeaders, timeout: 8000 })).data;
  const hHeaders = { Authorization: `Bearer ${hsToken}`, 'Content-Type': 'application/json' };
  const search = async (filters, properties) => {
    const out = [];
    let after;
    for (let page = 0; page < 10; page++) {
      const body = { filterGroups: [{ filters }], properties, limit: 100 };
      if (after) body.after = after;
      const r = (await axios.post(`${HUBSPOT}/crm/v3/objects/${CONFIG_OBJECT}/search`, body, { headers: hHeaders, timeout: 8000 })).data;
      out.push(...(r.results || []));
      after = r.paging && r.paging.next && r.paging.next.after;
      if (!after) break;
    }
    return out;
  };
  const outOfTime = () => Date.now() - started > TIME_BUDGET_MS;

  try {
    const drafts = await search([{ propertyName: 'needs_setup', operator: 'EQ', value: 'true' }], ['name', 'stripe_price_id']);
    stats.needsSetup = drafts.length;
    drafts.slice(0, 5).forEach((d) => lines.push(`Needs setup: ${(d.properties || {}).name || d.id} (${(d.properties || {}).stripe_price_id || 'no price id'})`));

    const rules = await search([
      { propertyName: 'record_type', operator: 'EQ', value: 'product' },
      { propertyName: 'plan_type', operator: 'EQ', value: PLAN_ENDS },
      { propertyName: 'active', operator: 'EQ', value: 'true' },
    ], ['name', 'stripe_price_id', 'total_payments']);

    for (const rule of rules) {
      if (outOfTime()) { truncated = true; break; }
      const r = rule.properties || {};
      const priceId = r.stripe_price_id;
      const rulePayments = parseInt(r.total_payments, 10);
      if (!priceId || IGNORE_PRICE_PREFIXES.some((p) => priceId.startsWith(p))) continue;

      let startingAfter;
      for (let page = 0; page < 5; page++) {
        if (outOfTime()) { truncated = true; break; }
        const params = { price: priceId, status: 'all', limit: 100, 'expand[]': 'data.items.data.price' };
        if (startingAfter) params.starting_after = startingAfter;
        const list = await sget('/subscriptions', params);
        for (const sub of list.data || []) {
          if (outOfTime()) { truncated = true; break; }
          if (!LIVE.includes(sub.status) || sub.application || sub.schedule) continue;
          const item = ((sub.items && sub.items.data) || []).find((i) => i.price && i.price.id === priceId);
          if (!item || !item.price.recurring) continue;
          stats.checked++;
          const payments = parseInt(sub.metadata && sub.metadata.total_payments, 10) || rulePayments;
          if (!payments) continue;
          const expected = addPeriods(sub.billing_cycle_anchor, item.price.recurring, payments);
          if (!expected) continue;
          const now = Math.floor(Date.now() / 1000);

          if (!sub.cancel_at) {
            if (expected <= now) {
              stats.overdue++;
              lines.push(`Past its end, still charging: ${sub.id} (${r.name}, should have ended ${day(expected)})`);
            } else if (writeOn) {
              await axios.post(
                `https://api.stripe.com/v1/subscriptions/${sub.id}`,
                qs.stringify({ cancel_at: expected, proration_behavior: 'none' }),
                { headers: { ...sHeaders, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `plan-end-${sub.id}-${expected}` }, timeout: 8000 },
              );
              stats.fixed++;
              lines.push(`End date set: ${sub.id} (${r.name}, ends ${day(expected)})`);
            } else {
              stats.wouldFix++;
              lines.push(`No end date: ${sub.id} (${r.name}, would end ${day(expected)})`);
            }
          } else if (sub.cancel_at !== expected) {
            stats.mismatches++;
            lines.push(`Off the rule: ${sub.id} (${r.name}) ends ${day(sub.cancel_at)}, rule says ${day(expected)}`);
          }

          const paid = await sget('/invoices', { subscription: sub.id, status: 'paid', limit: 100 });
          const paidCount = (paid.data || []).filter((inv) => (inv.amount_paid || 0) > 0).length;
          if (paidCount > payments) {
            stats.overpaid++;
            lines.push(`Overpaid: ${sub.id} (${r.name}) has ${paidCount} paid invoices, rule allows ${payments}`);
          }
        }
        if (truncated || !list.has_more || !(list.data || []).length) break;
        startingAfter = list.data[list.data.length - 1].id;
      }
      if (truncated) break;
    }
    return done();
  } catch (e) {
    const msg = (e.response && e.response.data && ((e.response.data.error && e.response.data.error.message) || e.response.data.message)) || e.message;
    return done({ error: String(msg) });
  }
};
