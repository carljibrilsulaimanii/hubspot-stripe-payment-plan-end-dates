<!--
  README.md -- Payment plan end dates for Stripe subscriptions, set from HubSpot
  Author:  Jibril Sulaiman
  Date:    2026-11-18
  What:    Click-by-click guide for a HubSpot workflow that makes every Stripe payment
           plan stop by itself after its last payment, by setting the subscription's
           end date (cancel_at) the moment the first payment reaches HubSpot.
  Why:     Stripe Payment Links in subscription mode create recurring subscriptions
           with no end. A "3 payments" plan keeps charging a 4th, 5th and 6th time
           unless something sets an end date.
-->

# Payment plan end dates for Stripe subscriptions, set from HubSpot

Selling a "pay in 3" or "2 payments, 14 days apart" plan through a Stripe Payment Link
creates a normal recurring subscription, and Stripe keeps charging it until something
cancels it. This repo is one HubSpot workflow with a custom code action that runs when
a plan payment reaches HubSpot, finds the Stripe subscription behind it, and sets the
date it ends: the moment payment N+1 would be due. Stripe then stops on its own after
exactly N payments, with no partial charge.

It's for teams that take Stripe payments outside HubSpot Commerce and run their
follow-up in HubSpot, using HubSpot's Stripe Data Sync to bring payments in.

There are two ways to set it up:

- **Part 1, the plan list in code** (Steps 1-6): one workflow, with your plans listed
  in the custom code. Quick to set up; each new plan is a one-line code change.
- **Part 2, the rules table** (Steps 7-12): a **Payment Product Config** custom object
  holds one record per plan price, with its number of payments. A workflow reads the
  rule for every new subscription, creates a draft rule for any price it doesn't know,
  and a daily check sets any missing end date and reports anything off. Adding a plan
  is a record, not a code change.

## Why it exists

**Stripe doesn't know a payment plan has an end.**

1. A Payment Link in subscription mode creates a subscription with a recurring price
   (for example $500 every month). Stripe has no "stop after N payments" setting on
   the link, so the subscription renews until it's cancelled.
2. A `total_payments: 3` entry in the subscription's metadata is only a label. Stripe
   ignores metadata when billing, so it keeps charging.
3. Stripe can end a subscription two ways, and only one fits a payment plan:
   - **Cancel at end of period** (`cancel_at_period_end`) stops after the *current*
     period. Set after payment 1, that loses payments 2 and 3.
   - **Cancel at a date** (`cancel_at`) stops at an exact moment. Set to the moment
     payment N+1 would be due, Stripe charges exactly N times. This repo sets that.
4. Changing a subscription takes an API call per subscription, at the right time, for
   every buyer. Doing it by hand gets missed. In production, a 3-payment plan sold for a
   week before anyone noticed every subscription was set to charge a 4th time.

A HubSpot workflow is a natural place for the call: Stripe Data Sync puts every payment
into HubSpot within minutes, and a custom code action can read the subscription behind
it and set the end date once.

## How it works

```text
 Buyer pays payment 1 through a Payment Link (subscription mode)
        │
        ▼
 Stripe ──► HubSpot Stripe Data Sync ──► payment record (description, status, pi_... id)
                                              │
                Workflow: Payment plan end date (Stripe)
                trigger: description says it's a plan payment, status succeeded
                custom code:
                  payment ─► invoice ─► subscription (with its price and product)
                  product name in the PLANS list?   no ─► SKIPPED
                  already has an end date/schedule? yes ─► ALREADY_SET
                  cancel_at = billing anchor + N × billing interval
                  POST /v1/subscriptions/{id}  cancel_at, proration_behavior=none ─► SET
                                              │
                result = ERROR ─► Slack alert │
                                              ▼
 Stripe charges payments 2..N on schedule, then the subscription ends by itself.
```

Example, 2 payments every 14 days: payment 1 on day 0, payment 2 on day 14, the
subscription ends on day 28, the moment payment 3 would have been charged.

The action runs again on every later plan payment, but only writes once: once the end
date is there, every later run returns `ALREADY_SET`.

## What's in this repo

| Path | What it is | Where it goes |
|---|---|---|
| [`workflow-action/payment-plan-end-date.js`](workflow-action/payment-plan-end-date.js) | Part 1: the action with the plan list in code | Pasted into the workflow (Step 4) |
| [`workflow-action/rules/`](workflow-action/rules/) | Part 2: the action that reads the rules table, and the daily check | Pasted into the two Part 2 workflows (Steps 10 and 11) |
| [`test/`](test/) | Offline tests with Stripe and HubSpot faked and the clock frozen | `npm test` |

## Table of contents

- [Prerequisites and dependencies](#prerequisites-and-dependencies)
- [Setup, step by step](#setup-step-by-step)
  - [Step 1: Find how your plan payments arrive](#step-1-find-how-your-plan-payments-arrive)
  - [Step 2: A restricted Stripe key](#step-2-a-restricted-stripe-key)
  - [Step 3: List your plans in the code](#step-3-list-your-plans-in-the-code)
  - [Step 4: The workflow](#step-4-the-workflow)
  - [Step 5: Turn it on and fix past buyers](#step-5-turn-it-on-and-fix-past-buyers)
  - [Step 6: Adding a plan later](#step-6-adding-a-plan-later)
- [Part 2: the rules table](#part-2-the-rules-table)
  - [Step 7: The Payment Product Config object](#step-7-the-payment-product-config-object)
  - [Step 8: Rules for your plans and the Global record](#step-8-rules-for-your-plans-and-the-global-record)
  - [Step 9: A HubSpot service key and the second secret](#step-9-a-hubspot-service-key-and-the-second-secret)
  - [Step 10: Workflow "Payment plans - Set end date"](#step-10-workflow-payment-plans---set-end-date)
  - [Step 11: Workflow "Payment plans - Daily check"](#step-11-workflow-payment-plans---daily-check)
  - [Step 12: Switch over from Part 1 and turn on write mode](#step-12-switch-over-from-part-1-and-turn-on-write-mode)
- [How the end date is worked out](#how-the-end-date-is-worked-out)
- [Troubleshooting](#troubleshooting)
- [Limits](#limits)
- [Security](#security)
- [Related repos: Stripe beyond HubSpot Commerce](#related-repos-stripe-beyond-hubspot-commerce)

## Prerequisites and dependencies

**Accounts, plans and tiers**

| What | Version or plan | Why | Check it's ready |
|---|---|---|---|
| HubSpot | Workflows plus **custom code actions** (Data Hub, formerly Operations Hub, Professional or above at the time of writing) | The workflow and its code step | **Automation → Workflows → Create workflow**; the action list has **Custom code** |
| HubSpot's Stripe Data Sync, syncing **payments** into a custom object | Any plan that includes Data Sync | The payment records the workflow enrolls. See [hubspot-stripe-data-sync-setup-and-recovery](https://github.com/carljibrilsulaimanii/hubspot-stripe-data-sync-setup-and-recovery). | A recent Stripe payment appears in that object with its PaymentIntent id (`pi_...`) |
| Stripe | Any account selling plans through Payment Links in subscription mode | The subscriptions this ends | **Product catalog**: the plan's price is recurring |
| Slack connected to HubSpot | Optional | The error alert in Step 4f and the daily summary in Step 11 | The workflow action list has **Send Slack notification** |
| HubSpot custom objects | Enterprise (any hub) at the time of writing | Part 2 only: the Payment Product Config object | **Settings → Data Management → Objects** offers **Create custom object** |
| HubSpot's Stripe Data Sync, syncing **subscriptions** into a custom object | Same as above | Part 2 only: the records the Set end date workflow enrolls | A new Stripe subscription appears in that object with its id (`sub_...`) |
| Scheduled workflows | Workflows with **Based on a schedule** triggers | Part 2 only: the daily check | The trigger picker offers **Based on a schedule** (wording may differ) |

**Permissions and scopes**

| What | Version or plan | Why | Check it's ready |
|---|---|---|---|
| HubSpot user | Can create workflows and manage secrets | Steps 4 and 5 | You can open **Secrets** in a custom code action |
| Stripe user | Can create restricted keys (Administrator or Developer) | Step 2 | **Developers → API keys** shows **Create restricted key** |
| Stripe restricted key, stored as HubSpot secret `Stripe_Subscription_End` | **Subscriptions: Write**, **Invoices: Read**, **PaymentIntents: Read**, **Products: Read**; everything else None | The code reads the payment, invoice, subscription and product, and writes only `cancel_at` | The key's permission list shows exactly those four |
| HubSpot service key, stored as HubSpot secret `Payment_Rules_Token` | `crm.objects.custom.read`, `crm.objects.custom.write` | Part 2 only: the actions read rules and create draft rules | The key's page lists those two scopes |
| HubSpot user for Part 2 | Can create custom objects and properties (Super Admin, or the data management permission) | Steps 7 and 8 | You can open **Settings → Data Management → Objects** |

**Tools with versions**

| What | Version or plan | Why | Check it's ready |
|---|---|---|---|
| Node.js | 20 or later | Only to run the tests (`npm test`); HubSpot runs the action itself on Node.js 20.x | `node --version` |
| `axios`, `querystring` | Provided by HubSpot's custom code runtime | Used by the action | Nothing to install |

**Claude Code (optional)**

| What | Version or plan | Why | Check it's ready |
|---|---|---|---|
| Claude Code | Any current version | Used to write and test the action, and to list live subscriptions with a read-only Stripe key to confirm every plan got an end date. It can't create the HubSpot workflow for you (build it in the editor). | `claude --version` |

The whole build can be done by hand without Claude.

## Setup, step by step

### Step 1: Find how your plan payments arrive

About 5 minutes. The trigger in Step 4 has to match your plan payments and nothing
else, so look at what Stripe Data Sync writes into **Description** first.

**1a.** In HubSpot, open the custom object that Stripe Data Sync writes payments into
(for example **Stripe Payment Transactions**) and filter to recent **succeeded**
payments.

**1b.** Find a payment made through each plan link and note its **Description**. You
will usually see one of two shapes:

| Description you see | Where it comes from | Matched in Step 4b by |
|---|---|---|
| Your product name, e.g. `Course - Payment Plan (3 x $500)` | The link or checkout set a description | **Description contains** `Payment Plan` |
| `Subscription creation` | Stripe's default for the first invoice of a subscription when the link sets no description | **Description contains** `Subscription creation` |

> ⚠️ **You often can't fix the description at the link.** Stripe's API refuses to add
> a subscription description to an existing Payment Link, so payments from those links
> arrive as `Subscription creation`. That's why the trigger has a second group, and why
> the code (not the trigger) decides which product it is.

**1c.** For each plan, note the **Stripe product name** on its recurring price
(**Product catalog → the product**). The code matches on this name, not on the
description.

✅ **Check:** for every plan link you have its product name and the description its
payments arrive with.

### Step 2: A restricted Stripe key

About 3 minutes.

**2a.** In Stripe (live mode), **Developers → API keys → Restricted keys → Create
restricted key**.

**2b.** At *"How will you be using this key?"* choose **Powering an integration you
built**, **Continue**, then **Choose your own →** (wording may differ).

**2c.** Set these permissions and leave everything else at **None**:

| Resource | Permission |
|---|---|
| Subscriptions | **Write** |
| Invoices | **Read** |
| PaymentIntents | **Read** |
| Products | **Read** |

Name it for this job, for example `HubSpot - payment plan end date`, create it, and
copy the `rk_live_...` key.

> ⚠️ **Don't reuse a broader key.** This key should be able to change subscriptions
> and nothing else. Reusing a key another integration owns means rotating it breaks
> both, and the error names neither.

✅ **Check:** an `rk_live_` key with exactly those four permissions.

### Step 3: List your plans in the code

About 5 minutes.

**3a.** Open [`workflow-action/payment-plan-end-date.js`](workflow-action/payment-plan-end-date.js)
and find the `PLANS` list near the top:

```js
const PLANS = [
  { name: 'Course payment plan', test: /course.*payment plan/i, payments: 3 },
  { name: 'Workshop payment plan', test: /workshop.*payment plan/i, payments: 2 },
];
```

**3b.** Replace the two examples with your plans, one line each:

| Field | What to put |
|---|---|
| `name` | A label for the outputs and the Slack alert |
| `test` | A pattern that matches the **Stripe product name** from 1c (case-insensitive). Make it specific enough to never match a pay-in-full product. |
| `payments` | How many payments the plan takes |

The first match wins, so put more specific patterns first. A product that matches none
is skipped, which keeps the action away from every other subscription on the account
(memberships, or subscriptions another app creates through your Stripe account).

**3c.** Optional: if a link sets `total_payments` in its **subscription metadata**,
that number wins over `payments` for buyers of that link.

✅ **Check:** every plan product from 1c matches exactly one pattern, and no
pay-in-full or membership product matches any.

### Step 4: The workflow

About 15 minutes.

**4a. Create it.** **Automation → Workflows → Create workflow → From scratch**. Object
type: your Stripe payments object. Name it `Payment plan end date (Stripe)`.

**4b. Trigger.** Enroll records that meet custom conditions. Build these filter groups
(groups are OR; filters inside a group are AND):

| Group | Filters |
|---|---|
| 1 | **Description** contains `Payment Plan` · **Status** is equal to `succeeded` |
| 2 | **Description** contains `Subscription creation` · **Status** is equal to `succeeded` |

Add a product word to group 1 if other products' descriptions also contain "Payment
Plan" and you want fewer enrollments; the code skips non-matches either way.

Leave **Re-enrollment** off. Each payment is its own record, and the code writes once
per subscription anyway.

> ⚠️ **Keep test payments out.** If you mirror Stripe test-mode payments into the same
> object ([stripe-test-mode-to-hubspot-payment-mirror](https://github.com/carljibrilsulaimanii/stripe-test-mode-to-hubspot-payment-mirror)),
> add **Record Environment** is none of `Test` to each group, with **Include objects
> with no value** ticked, since live payments leave it empty (wording may differ).

**4c. Custom code.** Click **+**, choose **Custom code**.

1. **Language:** Node.js 20.x
2. **Secrets:** open the dropdown, click **Add secret**, name it exactly
   `Stripe_Subscription_End`, paste the key from Step 2, save, and tick it for this
   action.
3. **Property to include in code:**

   | Input name (left box) | Value (right box) |
   |---|---|
   | `piId` | The payment's PaymentIntent id property, e.g. **Stripe Payment Transaction ID** (enrolled record). It starts with `pi_`. |

4. Delete the sample code and paste in **all** of
   [`workflow-action/payment-plan-end-date.js`](workflow-action/payment-plan-end-date.js),
   with your `PLANS` list from Step 3.
5. **Data outputs**, all type String:

   | Output | Type | Holds |
   |---|---|---|
   | `result` | String | `SET`, `ALREADY_SET`, `SKIPPED` or `ERROR` |
   | `subscriptionId` | String | The Stripe subscription (`sub_...`) |
   | `cancelAt` | String | The end date, ISO format |
   | `detail` | String | A one-line explanation |

   An output only shows up when it's defined in **both** the code and this form.

> ⚠️ **"callback is not a function".** Newer custom code actions don't pass a callback.
> The action returns its outputs and only calls `callback` when it exists, so it works
> either way. If you trim the code, keep that.

**4d. Test action.** Open **Test action**, pick a recent plan payment whose subscription
has no end date yet, and click **Test**.

> ⚠️ **A test is a real change.** It sets the end date on that buyer's live
> subscription. That's what you want for a real plan buyer, but test on one you've
> checked by hand.

| `result` | Meaning | What to do |
|---|---|---|
| `SET` | End date written | Open the subscription in Stripe and check the date |
| `ALREADY_SET` | It already had an end date or a schedule | Nothing |
| `SKIPPED` | Not a listed plan, not a subscription payment, or the subscription isn't active | Read `detail`; fix `PLANS` if it's a plan you meant to cover |
| `ERROR` | Missing secret, unexpected billing interval, end date in the past, or a Stripe error | Read `detail` (see Troubleshooting) |

**4e. Branch on the result.** Add an **If/then branch** on the custom code output
`result` with one branch: `result` is equal to `ERROR`.

**4f. Alert.** On the `ERROR` branch add **Send Slack notification** (or an internal
email) with the payment, `subscriptionId` and `detail` in the message. The other
results need no action.

✅ **Check:** the test returned `SET`, and in Stripe the subscription shows
**Cancels** on the date payment N+1 would have been due, with payments 2 to N still
scheduled.

### Step 5: Turn it on and fix past buyers

About 10 minutes.

**5a.** Click **Review and publish**. When HubSpot asks whether to enroll existing
records that meet the trigger, choose **Yes** (wording may differ). Every past plan
buyer whose first payment is already in HubSpot gets an end date in this one pass.

**5b.** Open the workflow's **History**. Each past buyer shows `SET` (or `ALREADY_SET`
for later payments of the same plan).

**5c.** Spot-check three or four subscriptions in Stripe (**Billing → Subscriptions →
the subscription**): each should show **Cancels** on its date, with the remaining
payments still listed as upcoming.

> ⚠️ **Don't fix past buyers with "cancel at end of period".** Doing it by hand in the
> dashboard is tempting for a few buyers, but that option stops after the current
> period and loses the remaining payments. Let the workflow set the exact date.

✅ **Check:** every active subscription on your plan prices has an end date. In
Stripe, filter **Billing → Subscriptions** by the plan's price and open each one, or
list them with the API and look for an empty `cancel_at`.

### Step 6: Adding a plan later

About 5 minutes.

**6a.** Add one line to `PLANS` in the action (Step 3) for the new product.

**6b.** Check the new link's payments arrive with a description the trigger already
matches (Step 1). If they don't, add a filter group.

**6c.** Publish the workflow. New buyers get their end date on their first payment.
For buyers who already paid before you added the line, use the workflow's **Enroll**
button to enroll their first payment.

✅ **Check:** the next buyer of the new plan shows `SET` in the workflow history
within a few minutes of paying.

## Part 2: the rules table

Part 2 moves the plan list out of the code and into HubSpot records. It replaces the
Part 1 workflow once it's on (Step 12); don't run both on the same plans for long.

```text
 New Stripe subscription ──► Data Sync ──► subscription record (sub_...)
                                              │
       Workflow "Payment plans - Set end date"│
       custom code: subscription ─► price ─► rule in Payment Product Config
         no rule ───────────► draft rule (needs setup) + Slack
         renews / ignore ───► nothing
         ends after N ──────► Global write mode on?  yes ─► cancel_at set (SET)
                                                     no ──► WOULD_SET (report only)

       Workflow "Payment plans - Daily check" (Global record, every morning)
       for each "ends after N" rule ─► every live subscription on that price:
         no end date ─► set it (write mode) or report it
         end date off the rule, overpaid, past its end ─► report, never change
       summary ─► Global record + Slack
```

### Step 7: The Payment Product Config object

About 20 minutes.

**7a.** **Settings → Data Management → Objects → Create custom object** (wording may
differ). Singular name `Payment Product Config`, plural `Payment Product Configs`.
Primary display property: **Name**.

**7b.** Associate it with your Stripe subscriptions object and your Stripe payments
object (**Associations** tab on the object's settings).

**7c.** Create these properties on the object. The internal values of the dropdowns
must be exactly as shown, because the code compares them:

| Property (internal name) | Field type | Options: label → internal value | What it's for |
|---|---|---|---|
| `name` | Single-line text | | The plan, e.g. "Course: Payment Plan" |
| `record_type` | Dropdown select | Product → `product`, Global → `global` | One Global record holds the settings; every other record is a plan price |
| `stripe_price_id` | Single-line text, **Require unique values** on | | The plan's recurring price, `price_...` |
| `stripe_product_id` | Single-line text | | The Stripe product, `prod_...` |
| `plan_type` | Dropdown select | Ends after a set number of payments → `ends`, Renews until cancelled → `renews`, Not ours (ignore) → `ignore` | What happens to subscriptions on this price |
| `total_payments` | Number | | How many payments the plan takes |
| `active` | Single checkbox | | Off for a retired price |
| `needs_setup` | Single checkbox | | On for drafts the workflow creates |
| `notes` | Multi-line text | | Who set the rule and why |
| `plan_write_mode` | Dropdown select | On → `on`, Report only → `report_only` | Global record only: whether anything is written to Stripe |
| `plan_last_check_at` | Date picker with time (wording may differ) | | Global record only: filled by the daily check |
| `plan_last_check_summary` | Multi-line text | | Global record only: filled by the daily check |

**7d.** Copy the object's type id (it looks like `2-12345678`; it's in the address bar
when you open the object's records). Paste it into `CONFIG_OBJECT` at the top of
**both** [`workflow-action/rules/set-end-date-from-rules.js`](workflow-action/rules/set-end-date-from-rules.js)
and [`workflow-action/rules/daily-check.js`](workflow-action/rules/daily-check.js).
Until you do, both actions stop with an error naming `CONFIG_OBJECT`.

> ⚠️ **Other apps' subscriptions.** If another app creates subscriptions on your
> Stripe account (a community or membership platform, for example), the actions skip
> anything created through a connected app (`application` is set). If that app's prices
> share a recognizable prefix, also add it to `IGNORE_PRICE_PREFIXES` in both files.

✅ **Check:** the object exists with all twelve properties, and both files have your
object type id.

### Step 8: Rules for your plans and the Global record

About 10 minutes.

**8a.** Create one record per plan price:

| Field | Example |
|---|---|
| Name | Course: Payment Plan |
| Record type | Product |
| Stripe price ID | `price_...` from **Product catalog → the product → the recurring price** |
| Stripe product ID | `prod_...` |
| Plan type | Ends after a set number of payments |
| Number of payments | 3 |
| Active | On |
| Needs setup | Off |

**8b.** Create one record for each recurring price that should **never** end (an
annual membership, for example) with **Plan type** = *Renews until cancelled*. That
stops it from showing up as a draft.

**8c.** Create the **Global** record: Name `Global settings`, Record type *Global*,
**Plan write mode** = *Report only*. Keep it on Report only until Step 12.

✅ **Check:** one record per plan price with Active on, and exactly one Global
record.

### Step 9: A HubSpot service key and the second secret

About 5 minutes.

**9a.** In HubSpot's **Service Keys** page, click **Create service key**, name it for
this job (for example `Payment plan rules`), add the scopes
`crm.objects.custom.read` and `crm.objects.custom.write`, and click **Create**.

**9b.** You'll add it as the secret `Payment_Rules_Token` in Steps 10 and 11. Both
actions also use `Stripe_Subscription_End` from Step 2.

> ⚠️ **Give this job its own key.** The rules actions only need custom-object access.
> A shared key with broader scopes works too, until someone rotates it for another
> integration and these actions fail with a 401 that names neither.

✅ **Check:** a service key with exactly those two scopes.

### Step 10: Workflow "Payment plans - Set end date"

About 15 minutes.

**10a. Create it.** **Automation → Workflows → Create workflow → From scratch**.
Object type: your **Stripe subscriptions** object. Name it
`Payment plans - Set end date`.

**10b. Trigger.** Enroll records that meet custom conditions: **Status** is any of
`active`, `trialing`, `past_due`. Leave **Re-enrollment** off: a subscription only
needs its end date once.

**10c. Custom code.** Click **+**, choose **Custom code**.

1. **Language:** Node.js 20.x
2. **Secrets:** `Stripe_Subscription_End` and `Payment_Rules_Token` (click **Add
   secret** to create the second one with the key from Step 9).
3. **Property to include in code:**

   | Input name (left box) | Value (right box) |
   |---|---|
   | `subscriptionId` | The subscription's Stripe id property (enrolled record), `sub_...` |

4. Delete the sample code and paste in **all** of
   [`workflow-action/rules/set-end-date-from-rules.js`](workflow-action/rules/set-end-date-from-rules.js),
   with your object type id in `CONFIG_OBJECT` (Step 7d).
5. **Data outputs**, all type String:

   | Output | Holds |
   |---|---|
   | `result` | `SET`, `WOULD_SET`, `ALREADY_SET`, `NO_RULE`, `RENEWS`, `IGNORED`, `SKIPPED` or `ERROR` |
   | `subscriptionId` | The subscription |
   | `cancelAt` | The end date (set, or would be set), ISO format |
   | `totalPayments` | The number of payments used |
   | `ruleId` | The rule record used, or the draft created |
   | `detail` | A one-line explanation |

**10d. Record the result on the subscription.** Create three properties on your
Stripe subscriptions object: `plan_status` (single-line text), `plan_total_payments`
(number) and `plan_end_date` (single-line text). Add an **Edit record** action after
the code that sets them from the outputs `result`, `totalPayments` and `cancelAt`, so
property history shows what was done.

**10e. Branch and alert.** Add an **If/then branch** on `result` with two branches:
`NO_RULE` and `ERROR`. On each, add **Send Slack notification** with the
subscription, `detail` and (for `NO_RULE`) a link to the draft rule `ruleId`.

**10f. Test action.** Pick a recent subscription on one of your plan prices and click
**Test**. With the Global record on Report only, success is `WOULD_SET` with the
`cancelAt` you expect. Nothing is written to Stripe.

| `result` | Meaning | What to do |
|---|---|---|
| `SET` | End date written (write mode On) | Check it in Stripe |
| `WOULD_SET` | Report only: this is what it would set | Compare with your plan |
| `ALREADY_SET` | The subscription already has an end date or schedule | Nothing |
| `NO_RULE` | No rule for the price, or the rule isn't finished; a draft was created | Fill in the draft (Step 8) |
| `RENEWS` / `IGNORED` | The rule says leave it | Nothing |
| `SKIPPED` | Another app's subscription, an ignored price, or not live | Nothing |
| `ERROR` | Missing secret or object id, rule without a number of payments, end date in the past, or a Stripe/HubSpot error | Read `detail` |

**10g.** Publish it. Leave existing records out for now; Step 12 covers past buyers.

✅ **Check:** the test returned `WOULD_SET` with the right date, and a test on a price
with no rule created a draft record with **Needs setup** on.

### Step 11: Workflow "Payment plans - Daily check"

About 15 minutes.

**11a. Create it.** **Automation → Workflows → Create workflow → From scratch**.
Object type: **Payment Product Config**. Name it `Payment plans - Daily check`.

**11b. Trigger.** **Based on a schedule**, **Daily**, at a quiet time (for example
7:00 AM in your time zone), with the filter **Record type** is *Global* (wording may
differ). Only the Global record enrolls.

> ⚠️ **Set the schedule in the editor.** If you edit this workflow through HubSpot's
> API later, re-check the trigger: a save through the API can replace a scheduled
> trigger with a plain filter trigger.

**11c. Custom code.** Click **+**, choose **Custom code**.

1. **Language:** Node.js 20.x
2. **Secrets:** `Stripe_Subscription_End` and `Payment_Rules_Token`
3. **Property to include in code:**

   | Input name (left box) | Value (right box) |
   |---|---|
   | `writeMode` | **Plan write mode** (enrolled record) |

4. Delete the sample code and paste in **all** of
   [`workflow-action/rules/daily-check.js`](workflow-action/rules/daily-check.js),
   with your object type id in `CONFIG_OBJECT`.
5. **Data outputs:**

   | Output | Type | Holds |
   |---|---|---|
   | `summary` | String | One line of totals, then one line per finding |
   | `issues` | Number | How many things need a look (0 = all good) |
   | `checked` | Number | Plan subscriptions checked |
   | `fixed` | Number | End dates set this run (write mode) |
   | `wouldFix` | Number | End dates it would set (report only) |
   | `mismatches` | Number | End date differs from the rule |
   | `overpaid` | Number | More paid invoices than the rule allows |
   | `overdue` | Number | Should have ended, still charging |
   | `needsSetup` | Number | Draft rules waiting to be filled in |
   | `truncated` | String | `true` when the run stopped early for time |

**11d. Save the summary.** Add an **Edit record** action on the enrolled (Global)
record: **plan_last_check_at** = the time the action runs, **plan_last_check_summary**
= `summary`.

**11e. Alert only when needed.** Add an **If/then branch** on `issues` is greater
than `0`, and on that branch **Send Slack notification** with `summary`.

**11f. Test action**, then publish.

> ⚠️ **HubSpot stops custom code after about 20 seconds.** The check stops starting
> new subscriptions after 14 seconds and returns `truncated = true`. If that happens
> often, run it twice a day or split your rules across two Global-style runs.

✅ **Check:** the Global record shows a **Last check** time and a summary that matches
what you know about your plans.

### Step 12: Switch over from Part 1 and turn on write mode

About 10 minutes, then a week of watching.

**12a.** Turn on **Payment plans - Set end date** and **Payment plans - Daily check**.
Keep the Global record on **Report only**.

**12b.** Turn off the Part 1 workflow **Payment plan end date (Stripe)** the same day,
so only one system writes end dates.

**12c.** Read the daily summaries for a week. Every existing plan subscription that
already has an end date should be quiet. Anything in `wouldFix` is a subscription the
Part 1 workflow missed; anything in `mismatches` is worth a manual look.

**12d.** Set the Global record's **Plan write mode** to **On**. From the next run,
missing end dates are set, by the Set end date workflow for new subscriptions and by
the daily check for existing ones.

> ⚠️ **Changing a rule doesn't change existing customers.** Neither action ever moves
> an end date that's already set. If a customer's plan really changed, change their
> subscription by hand in Stripe.

✅ **Check:** after write mode is on, the next new plan buyer's subscription record
shows **plan_status** = `SET`, and the next daily summary has 0 issues.

## How the end date is worked out

Stripe charges payment 1 on the subscription's **billing anchor** (the first charge,
or the end of a free trial). Payment *k* falls on anchor + (*k* − 1) intervals, so the
subscription must end exactly at anchor + *N* intervals:

| Plan | Payment 1 | Last payment | `cancel_at` |
|---|---|---|---|
| 2 payments every 14 days | day 0 | day 14 | day 28 |
| 3 monthly payments, started Jan 15 | Jan 15 | Mar 15 | Apr 15 |
| 3 monthly payments, started Jan 31 | Jan 31 | Mar 31 | Apr 30 (month-end clamped like Stripe) |

The code handles day, week, month and year intervals with any interval count, and
sends `proration_behavior=none` so Stripe never creates a partial charge or credit.
Ending at the exact boundary means the last period is never cut short.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `SKIPPED`, *"not a listed payment plan"* | The Stripe product name doesn't match any `PLANS` pattern | Step 3: check the name in **Product catalog** and fix the pattern |
| A plan buyer never enrolls | Their payment's description doesn't match the trigger | Step 1: look at the description and add a filter group in 4b |
| `ERROR`, *"Missing secret Stripe_Subscription_End"* | The secret isn't ticked on the action, or its name differs | Step 4c item 2 |
| `ERROR`, *"computed end … is in the past"* | A very old payment was enrolled; the plan should already have ended | Check that subscription by hand in Stripe |
| `ERROR` with a Stripe permission message | The key is missing **Subscriptions: Write** or a read permission | Step 2 |
| `ALREADY_SET` on a buyer you expected to change | The subscription already had an end date or a subscription schedule | Change it by hand if the existing date is wrong; the action never overwrites |
| *"callback is not a function"* | Old copy of the action without the return fix | Paste the current file again (Step 4c) |
| Test-mode payments enroll | Test payments share the object | Add the Record Environment filter (Step 4b) |
| Part 2: `ERROR`, *"Set CONFIG_OBJECT…"* | The object type id placeholder is still in the code | Step 7d, in both files |
| Part 2: every result is `WOULD_SET` | The Global record is on Report only, or there's no Global record | Step 12d |
| Part 2: `NO_RULE` on a price that has a rule | The rule's **Active** is off or **Needs setup** is on, or the price id doesn't match exactly | Step 8 |
| Part 2: the daily summary says *"stopped early: time limit"* | Too many plan subscriptions for one 20-second run | Step 11 warning |
| Part 2: HubSpot 401 or 403 in `detail` | `Payment_Rules_Token` is missing a scope or attached to the wrong key | Step 9 |

## Limits

- **The end date is fixed once set.** If a buyer misses a payment and Stripe retries,
  the subscription still ends on schedule, so it can end with money still owed. Your
  failed-payment follow-up has to collect it; this action doesn't move the date.
- **Plans that switch to another price** after the last payment (for example 3
  installments, then an annual renewal) need a two-phase Stripe subscription schedule,
  not an end date. The action leaves subscriptions with a schedule alone.
- **Part 1 keeps the plan list in the code.** Each new plan is a one-line code change
  and a republish. Part 2 moves it into records.
- **Part 2 finds unknown prices when a subscription starts, not before.** A new plan
  link with no rule shows up as a draft after its first buyer, and only gets an end
  date once the draft is filled in. Add the rule when you create the link.
- **The daily check only looks at prices with an "ends" rule.** A plan price nobody
  added a rule for is caught by the Set end date workflow's draft, not by the check.
- **20 seconds per run.** The daily check covers as many plan subscriptions as fit
  in about 14 seconds, then reports `truncated`.
- **Only the first matching item counts.** A subscription with several recurring items
  gets its end date from the first item that matches `PLANS`.
- **It needs the payment in HubSpot.** Payments that never sync (for example $0
  checkouts) never enroll. See
  [hubspot-stripe-zero-dollar-checkout-sync](https://github.com/carljibrilsulaimanii/hubspot-stripe-zero-dollar-checkout-sync).

## Security

- The Stripe key is a **restricted** key with four permissions and lives only in
  HubSpot's secrets. It never appears in the code, the outputs or the logs.
- The only write is `cancel_at` (with `proration_behavior=none`) on a subscription whose
  product you listed. Every other subscription on the account is read and skipped.
- Each write sends an idempotency key built from the subscription and the end date, so
  a retried run can't double-apply a different change.
- Part 2's HubSpot key has only custom-object read and write. It can read and create
  rule records; it can't touch contacts, deals or payments.
- Part 2 writes nothing to Stripe while the Global record is on **Report only**.
- Rotate the key in Stripe and update the secret if it's ever exposed. A new key
  doesn't cancel the old one; delete the old key in Stripe.

## Related repos: Stripe beyond HubSpot Commerce

This repo is one of a set of guides for taking Stripe payments without HubSpot
Commerce, and for getting the Stripe data that HubSpot's native Stripe
integration leaves out into HubSpot. Each one stands alone.

| Repo | What it adds |
|---|---|
| [hubspot-stripe-data-sync-setup-and-recovery](https://github.com/carljibrilsulaimanii/hubspot-stripe-data-sync-setup-and-recovery) | The base the rest builds on: HubSpot's Stripe Data Sync into payment and subscription objects, and getting it back when the connection dies (lost mappings, duplicates, backfill, the sync queue) |
| [hubspot-stripe-utm-attribution](https://github.com/carljibrilsulaimanii/hubspot-stripe-utm-attribution) | UTM attribution: keeps UTMs across pages when HubSpot form redirects drop them, gets them back from Stripe on the checkout success page, and writes them onto the payment record |
| [hubspot-order-form-stripe-checkout-link-integration](https://github.com/carljibrilsulaimanii/hubspot-order-form-stripe-checkout-link-integration) | A two-step HubSpot order form that hands buyers to a Stripe Payment Link with their email and campaign UTMs attached |
| [stripe-webhooks-to-hubspot-custom-events](https://github.com/carljibrilsulaimanii/stripe-webhooks-to-hubspot-custom-events) | Any Stripe event into a HubSpot workflow through the "Webhook event is received" trigger, no middleware |
| [hubspot-capi-server-side-lead-and-purchase-conversions-meta-google](https://github.com/carljibrilsulaimanii/hubspot-capi-server-side-lead-and-purchase-conversions-meta-google) | Stripe purchases sent server-side from HubSpot workflows to Meta and Google |
| [hubspot-stripe-zero-dollar-checkout-sync](https://github.com/carljibrilsulaimanii/hubspot-stripe-zero-dollar-checkout-sync) | Free and 100%-off Stripe Checkout orders, which create no payment, written into a HubSpot custom object, plus a backfill |
| [hubspot-stripe-payment-product-names-and-routing](https://github.com/carljibrilsulaimanii/hubspot-stripe-payment-product-names-and-routing) | Which product each Stripe payment was for, written onto the payment record, and a master workflow that routes buyers by product |
| **hubspot-stripe-payment-plan-end-dates** (this repo) | Payment plans sold through Stripe Payment Links stop by themselves after the last payment: a HubSpot workflow sets the end date on each subscription |
| [stripe-test-mode-to-hubspot-payment-mirror](https://github.com/carljibrilsulaimanii/stripe-test-mode-to-hubspot-payment-mirror) | Stripe test-mode payments in the same HubSpot object as live ones, so payment workflows can be tested without real charges |

---

Built by [Jibril Sulaiman](https://github.com/carljibrilsulaimanii).
