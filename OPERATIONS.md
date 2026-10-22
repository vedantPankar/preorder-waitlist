# PreOrder & Notify: operations guide

This app extends the Shopify React Router template. This file covers what you need to run
it; the README covers the template itself.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `EMAIL_PROVIDER` | for restock emails | `resend`, `postmark`, or `shopify_flow` (hands each email to a Shopify Flow workflow; needs the `read_customers` scope and the restock-trigger extension; only existing Shopify customers can be emailed) |
| `EMAIL_API_KEY` | for restock emails | Provider API key. Server-side only. |
| `EMAIL_FROM` | for restock emails | Sender address verified with the provider (`a@b.com` or `Name <a@b.com>`) |
| `NOTIFY_BATCH_SIZE` | optional | Deliveries claimed per batch (1-1000, default 100) |
| `NOTIFY_WORKER_INTERVAL_MS` | optional | `>=5000` starts an in-process loop that drains the queue and applies campaign start/end. Single-instance hosts only. |
| `EMAIL_SETTINGS_KEY` | optional | Encryption key for the Gmail app password saved in Settings (falls back to `SHOPIFY_API_SECRET`). Rotating it makes saved passwords unreadable until re-entered. |
| `CRON_SECRET` | optional | `>=16` chars. Enables `POST /api/notifications/run` for an external scheduler. Disabled (404) when unset. |

The Settings and Notification activity pages show exactly which email variables are missing
or invalid (never the key itself). Nothing is sent, and no waitlist entry is marked
notified, until a working provider is configured.

## How restock notifications run

1. `inventory_levels/update` (verified webhook, de-duplicated by webhook id) finds the
   variant. If it is in stock, waiting customers are moved into a durable queue
   (`NotificationDelivery`, one row per customer per restock event, unique so a restock can
   never email the same person twice).
2. Deliveries are sent in batches. A claim is a conditional update with a lease; a worker
   that dies mid-send loses its lease and the delivery is retried (at-least-once; Resend also
   receives an idempotency key).
3. Transient failures (network, 408, 429, 5xx) are retried with 1 min / 5 min / 30 min backoff;
   other 4xx and exhausted retries end as `FAILED` and can be retried from Notification activity.
4. A delivery becomes `ACCEPTED` only after the provider accepted it. That is not proof of
   inbox delivery, opens or purchases, and the app never claims otherwise.
5. If the webhook's time budget runs out, the rest continues in the background, via the
   "Process queue now" / "Send pending notifications" buttons, the optional worker, or the
   scheduler endpoint. Waitlists over 500 are drained in batches; nothing is dropped.

### External scheduler (serverless / multi-instance)

```
curl -X POST https://YOUR_APP/api/notifications/run -H "Authorization: Bearer $CRON_SECRET"
# optional: ?shop=your-store.myshopify.com
```
Call it every minute or so. It sends due notifications and applies campaign start/end
transitions. It returns per-shop counts only (no customer data).

## Pre-order campaigns and limits: what is and is not guaranteed

* Units **sold** are counted from Shopify inventory (negative stock) and refreshed by
  inventory webhooks. This is verified data.
* The pre-order button takes an **atomic hold** (`/apps/waitlist/reserve`) before adding to
  the cart (15 minutes, max 10 units per hold). Concurrent requests serialize on a database
  row, so together they can never hold more than the limit. Holds are released when the cart
  add fails, expire after 15 minutes, and settle when inventory shows the sale.
* **Shopify checkout is not gated by this app.** A customer who bypasses the button (direct
  cart URL, another app) is only stopped once an inventory update lets the app switch the
  variant to "stop selling at zero stock". Orders placed before that update can exceed the
  limit. Strict enforcement requires a Shopify Cart/Checkout Validation Function, which is
  not built here. The admin UI says this.
* Anyone can place holds through the public proxy endpoint, so a malicious visitor could tie
  up units for up to 15 minutes at a time. Limits per hold and the expiry bound the damage;
  add rate limiting at your edge if you expect abuse.
* Campaign start/end flips the inventory policy lazily (storefront config request, admin
  visit, inventory webhook) and on schedule if the worker/cron is running.
* Ending or pausing a campaign never sends restock emails. Only inventory rising above zero does.

## Database

Prisma with **SQLite** (`schema.prisma` hard-codes `file:dev.sqlite`). Migrations in
`prisma/migrations` are SQLite SQL. Before a production deployment move to a server database
(for example Postgres): change the provider/URL and regenerate the migrations. The reservation
logic uses plain conditional `UPDATE`s plus a token, which is correct on Postgres too. Note that
Postgres `contains` filters are case-sensitive (add `mode: "insensitive"` to the demand and waitlist searches).

Apply migrations: `npx prisma migrate deploy` (the Docker `setup` script does this).

## API scopes and webhooks

Scopes: `write_products, write_metaobjects, write_metaobject_definitions, read_inventory, read_customers`.
Webhooks: `app/uninstalled`, `app/scopes_update`, `inventory_levels/update` and the three privacy topics.

**Ship-date emails are dormant until the order webhooks are enabled.** The handlers
(`app/routes/webhooks.orders.create.jsx`, `webhooks.orders.cancelled.jsx`) exist, but the `read_orders` scope
and the `orders/create` / `orders/cancelled` subscriptions are **not** in `shopify.app.toml`: Shopify refuses to
start the app ("not approved to subscribe to webhook topics containing protected customer data") until the app
has protected customer data access. To turn them on: Partner/Dev Dashboard > the app > API access requirements >
Protected customer data access > request access, then add `read_orders` to `scopes` and these to the toml:

```
  [[webhooks.subscriptions]]
  uri = "/webhooks/orders/create"
  topics = [ "orders/create" ]

  [[webhooks.subscriptions]]
  uri = "/webhooks/orders/cancelled"
  topics = [ "orders/cancelled" ]
```

Until then the Settings toggles for ship-date reminders and change notices have no pre-order customers to email.
The signup confirmation and back-in-stock emails are unaffected.

`read_orders` and the two order webhooks exist only for ship-date emails (below): the app stores, per
pre-order line, the Shopify customer id, order number and product facts, never a name, email or
address. Merchants must approve the new scope when the app updates, and Shopify requires **protected
customer data access** for apps that read orders (Partner Dashboard > the app > API access
requirements). Purchases are still not attributed to notifications or campaigns.

## Sending with Gmail (Settings > Send with Gmail)

A shop can send its own emails through **Gmail or Google Workspace SMTP** (`smtp.gmail.com:465`) using an
**app password**. It is configured per shop in Settings; no server variables are needed except an encryption key.

**Setup**
1. Turn on **2-Step Verification** for the Google account (required by Google for app passwords).
2. Go to `myaccount.google.com/apppasswords`, create an app password (e.g. "Waitlist") and copy the 16 letters.
   Google Workspace admins may need to allow app passwords for the account.
3. In Settings > Send with Gmail enter the address and the app password and press **Save**. The app checks the
   login with Gmail first and refuses a rejected password. Use **Test email notification** to send yourself a message.
4. Optionally set the **daily send limit** (default 400).

**What it sends:** back-in-stock emails, signup confirmations and (once the order webhooks are enabled, see "API scopes")
ship-date reminders and change notices. Because the app sends them itself, **guests and any email address receive them**;
no Shopify customer is needed. The wording is fixed (the subject of the back-in-stock email is editable in Settings).
"Accepted" means Gmail took the message, not that it reached the inbox.

**Which sender is used:** (1) the shop's Gmail, if configured; otherwise (2) the server's `EMAIL_PROVIDER`
(Resend, Postmark or Shopify Flow). If Gmail is configured but unusable (sign-in rejected, or the saved password can no
longer be decrypted) **nothing is sent** and nothing is lost; the app does not quietly switch to another sender. Disconnect
Gmail in Settings to go back to the server's provider.

**Where the password lives:** encrypted in the database (AES-256-GCM, a fresh random IV per value, the shop domain bound in
so it cannot be copied between shops). The key is **never** stored in the database: it is derived from `EMAIL_SETTINGS_KEY`
when set, otherwise from `SHOPIFY_API_SECRET`. The password is write-only: it is not shown again, not sent to the browser,
not in API responses, logs or error messages (errors use fixed wording). **If the key changes** (rotating the secret),
saved passwords can no longer be read: Settings shows "The saved app password cannot be read" and nothing is sent until the
merchant enters it again. Set `EMAIL_SETTINGS_KEY` if you want a key separate from the API secret.

**Quota and the daily limit.** Gmail allows roughly **500 messages a day on a personal account and 2,000 on Google
Workspace**, and blocks the account when that is exceeded. The app counts sends per **Gmail account** (dots, `+tags` and
googlemail.com are the same account) per **UTC day**, so several stores using one account share one budget (each store's own
limit applies to that shared count). The limit is taken atomically, so parallel workers cannot exceed it. Over the limit,
deliveries are **not failed**: they stay queued, no attempt is used, and they go out after the limit resets (midnight UTC),
oldest first. Gmail's real limit is a rolling window, so keep the cap below it (the default 400 leaves room). If Gmail itself
reports "daily limit exceeded", the app marks the day as used and waits.

**Failures**
| What happened | What the app does |
|---|---|
| Gmail rejected the sign-in (bad/revoked app password, 2-Step Verification off) | Permanent. One attempt only (no repeated bad logins), the deliveries end `Failed`, Settings shows a red "Gmail rejected the sign-in" warning and nothing more is sent. Save a new app password (this clears the warning), then press "Retry failed" in Notification activity. |
| Network problem, SMTP 4xx reply | Temporary: retried after 1, 5 and 30 minutes, then `Failed` (retry button). |
| SMTP 5xx (e.g. the recipient does not exist) | Permanent for that email only. |
| Daily limit reached | Deferred to the next UTC day, nothing lost (see above). |

**Troubleshooting**
* "That is not an app password": it must be the 16-letter app password, not your normal Gmail password.
* "Gmail rejected this app password": check the address, that 2-Step Verification is on, and that the password was created
  for this same account; create a new one.
* Mail goes to spam: sending from a personal Gmail to many addresses is treated as bulk mail. Use a Workspace address on
  your own domain, and keep volumes modest.
* Gmail rewrites or limits the "From" address to the account (or its verified aliases). A "sender name" in Settings is the
  display name only.
* Nothing is sent and Settings shows no warning: check Notification activity for `Queued` rows with "Daily send limit".
* Emails need the server to be running: use the in-process worker (`NOTIFY_WORKER_INTERVAL_MS`) or the scheduler endpoint
  (`CRON_SECRET`) so deferred and retried emails are picked up.

**Not verified here:** the tests use a fake SMTP transport. A real send through Gmail has not been tried; do that with the
test button on your account before relying on it.

## Shopify Flow emails

These emails go out through Shopify Flow, like the back-in-stock email, so they need
`EMAIL_PROVIDER=shopify_flow`. With Resend/Postmark nothing is queued for them (Settings says so). Each
has its own toggle in **Settings > Shopify Flow emails** (all off by default). Only people who already
exist as **Shopify customers** can be emailed. Anyone else is listed in Notification activity as
`skipped: no Shopify customer` (this also applies to back-in-stock emails now, where it used to show as
failed). Guest email addresses do not receive these emails.

| Email | Flow trigger (from this app) | Fires |
|---|---|---|
| Back in stock | Waitlist restock notification | on restock (existing) |
| Waitlist signup confirmation | Waitlist signup confirmation | right after someone joins a waitlist |
| Ship-date reminder | Pre-order ship date update, `Reason` = `reminder` | N days before the expected ship date (Settings, default 3), once per ship date |
| Ship-date change | Pre-order ship date update, `Reason` = `changed` | when the expected ship date of an open pre-order changes, once per change |
| Pre-order confirmation | none: Shopify's **Order created** trigger | Shopify, when an order is placed |

Trigger fields: every trigger has the customer plus `Product title`, `Variant title`, `Product link`,
`Store domain`. The ship-date trigger adds `Reason` (`reminder` or `changed`), `Order name` and
`Ship date` (YYYY-MM-DD).

### Workflows to create in Shopify Flow (one per email)

1. **Signup confirmation:** Trigger *Waitlist signup confirmation* > action *Send marketing email*
   (Shopify Email). Say they are on the list; link with `Product link`.
2. **Ship-date reminder:** Trigger *Pre-order ship date update* > Condition `Reason` equals `reminder` >
   *Send marketing email* using `Ship date`, `Order name`, `Product title`.
3. **Ship-date change:** same trigger > Condition `Reason` equals `changed` > *Send marketing email*
   telling them the new `Ship date`.
4. **Pre-order confirmation (no app code):** Trigger *Order created* > Condition: an order line item has the
   property `_preorder` = `true` (or filter by a product tag you use for pre-order products) > *Send marketing
   email*. The cart line also carries `Expected shipping` for display. Shopify's normal order confirmation
   is sent regardless.

Shopify Email respects each customer's email marketing consent, so customers who did not consent get no
marketing email even when Flow accepted the trigger. Use Shopify's transactional notification templates
instead if you need an email that ignores consent.

### How it is checked, and what is not

Automated tests cover the trigger payloads, queue, retries, duplicate prevention, guest skipping, the
Settings toggles, the order webhooks and privacy deletion, against a mocked Shopify. **The Flow workflows and
Shopify Email sending themselves have not been verified** and cannot be from tests. Check on the development
store before relying on them:

1. Deploy to the dev store (`shopify app deploy` / `shopify app dev`), approve the new `read_orders` scope,
   and set `EMAIL_PROVIDER=shopify_flow`. The new Flow triggers appear in Flow once the extensions are deployed.
2. Create the four workflows above. Turn the toggles on in Settings.
3. Signup: join the waitlist of a sold-out variant with the email of an **existing customer**. Expect a Flow run
   for *Waitlist signup confirmation* and the email. Then join with an email that is **not** a customer:
   Notification activity shows `skipped: no Shopify customer`.
4. Pre-order: place a pre-order as an existing customer. Expect the *Order created* workflow and a new row
   after `orders/create` (check Notification activity later for the reminder).
5. Reminder: set the variant's ship date to within the reminder window (or raise "Days before shipping"),
   press **Process queue now** in Notification activity or call the scheduler endpoint. Expect one
   *Pre-order ship date update* run with `Reason = reminder`.
6. Change: edit the variant's (or campaign's) ship date, run the queue again. Expect `Reason = changed`, once.
7. Confirm in the Flow run history that each trigger received the fields above.

Reminders and change notices are only sent while the app is running its queue: use the in-process worker
(`NOTIFY_WORKER_INTERVAL_MS`) or the scheduler endpoint (`CRON_SECRET`); a webhook alone does not trigger them.

## Privacy

Click tracking is **off by default** (Settings). When on, only a click count is stored (no IP
address or device) and the email says links are counted. `customers/redact` removes a
customer's waitlist entries, deliveries and attempts; `shop/redact` removes everything. Finished
deliveries, events and reservations are purged with the retention setting.
