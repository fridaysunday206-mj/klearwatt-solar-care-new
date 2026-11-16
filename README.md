# KlearWatt Solar Care – Website + Paystack Payments

Professional solar panel cleaning website for **KlearWatt Solar Care**, serving **Karu Local Government Area, Nasarawa State, Nigeria**.

The website now has a premium, mobile-first green-and-neutral design, separate residential and commercial journeys, and a quotation-request form. The hero before-and-after image is promotional and illustrative, not a photograph of an actual KlearWatt customer job.

**Requires Node.js 22.13 or newer.** No npm dependencies to install.

---

## Business details (final)

| Item | Value |
|------|--------|
| Business name | KlearWatt Solar Care |
| WhatsApp **only** | 09037885738 → https://wa.me/2349037885738 |
| Telephone **only** | 07087942034 → tel:07087942034 |
| Email | fridaysunday206@gmail.com |
| Location | Karu Local Government Area, Nasarawa State, Nigeria |
| Coverage | Masaka, Mararaba, New Nyanya, Ado, One Man Village, Uke, Nyanya Gwandara, Karu town, and other communities within Karu LGA |

**Approved service positioning:** Professional solar-panel cleaning for residential and commercial customers in Karu LGA and surrounding communities. The business does not advertise solar installation, inverter repairs or general maintenance.

Never interchange the WhatsApp and telephone numbers.

---

## 1. What is implemented

- Customer registration / login, My Account (bookings, **Pay Now**, payment history, printable receipts) – `/account.html`
- Admin dashboard – `/admin.html` (editable prices, booking quotations, public residential/commercial quote requests, all transactions, manual cash/bank-transfer recording, re-check button)
- Paystack: one-time payments, monthly subscriptions (weekly / every-two-weeks packages billed monthly), automatic verification via Paystack’s server API, timestamped `Paystack-Signature` verification plus legacy `x-paystack-signature` support, renewal / failed-renewal / cancel handling
- Safety: secret key only in server environment; amount always read from the database; booking is “paid” only after Paystack confirms success with matching amount and NGN; unique references, atomic updates and webhook de-duplication stop double processing
- Prices are **not** pre-filled. Set them in Admin. A customer’s Pay Now button appears only when a price exists.
- 64 automated tests (`npm test`) against a mock Paystack: success, failed, cancelled, tampered amount, duplicates, webhook signature/replay, subscriptions (create, renewal, failed, cancel), manual payments, access control.  
  They prove the logic; they do **not** touch the real Paystack.

---

Business contact email: **fridaysunday206@gmail.com**. The public website focuses exclusively on residential and commercial solar-panel cleaning.

## 2. Accounts you need

1. **Paystack** account: https://dashboard.paystack.com/#/signup (test mode works immediately; live needs business verification)
2. **Hosting** that runs Node.js with a **persistent disk** (Railway, Render, Fly.io, or a VPS). Free tiers that wipe the disk will lose your data.
3. (Optional) a domain name with HTTPS (hosts give HTTPS automatically).

---

## 3. Where to get Paystack keys

Paystack Dashboard → Settings → API Keys & Webhooks.  
Use the **Test Secret Key** (`'sk' + '_' + 'test' + '_...'`) first. Live keys (`'sk' + '_' + 'live' + '_...'`) appear after your business is activated.  
**Never** put the secret key in any HTML/JS file, chat or email.

---

## 4. Environment variables (copy exactly)

| Variable | Required | Where the value comes from |
|----------|----------|----------------------------|
| `PAYSTACK_SECRET_KEY` | Yes | Paystack Dashboard → Settings → API Keys & Webhooks (Test or Live secret key) |
| `PAYSTACK_WEBHOOK_SECRET` | Recommended | Paystack Dashboard → Developers → API configuration → webhook signing secret (`'whsec' + '_...'`) |
| `SESSION_SECRET` | Yes | Any long random string (at least 24 characters). Generate one yourself. |
| `APP_URL` | Yes | Your live website URL with https, **no trailing slash** (e.g. `https://klearwatt.up.railway.app`) |
| `ADMIN_EMAIL` | Yes | The email you will use to log into `/admin.html` |
| `ADMIN_PASSWORD` | Yes | A strong password for the admin account |
| `DB_PATH` | Recommended | Path on the **persistent volume**, e.g. `/data/klearwatt.db` |
| `PORT` | Optional | Host sets this automatically (Railway, Render, etc.). Default 3000 for local. |

On the host, open **Environment Variables** (or Variables) and add the ones above.  
Locally: copy `.env.example` to `.env` and fill it in, then run `node server.js`.  
`.env` is never served to visitors.

In Paystack, set the webhook URL to:  
`https://YOUR-DOMAIN/api/paystack/webhook`  
Configure the Test-mode webhook signing secret as `PAYSTACK_WEBHOOK_SECRET` while testing, then use the Live-mode signing secret when switching to live. The server verifies the current timestamped `Paystack-Signature` header (including the 5-minute replay window) and also accepts the older `x-paystack-signature` header during Paystack’s transition. Keep `PAYSTACK_SECRET_KEY` because it is still needed for server-to-server API calls. Do not delete the Paystack API secret while relying on the legacy header.

Start command: `node server.js`

---

## 5. Railway deployment guide (beginner)

1. Create an account at https://railway.app.
2. On GitHub, create a new repository named `klearwatt-solar-care` and set it to **Private**.
3. Extract this ZIP first. In the new repository, use **Add file → Upload files** and upload the contents inside the `klearwatt-solar-care` folder. The repository root must contain `package.json`, `server.js`, `public/`, and `test/`; do not upload the ZIP itself or an extra enclosing folder. Include `.gitignore` and `.env.example`, but never upload a real `.env` file or database. Commit the upload.
4. In Railway choose **New Project → Deploy from GitHub Repo**, connect GitHub when asked, and select the KlearWatt repository.
5. Railway detects Node.js from `package.json`. This project requests Node.js `>=22.13`. No build command or dependency installation is needed. Set the Start Command to `npm start` (or `node server.js`).
6. Before the first deployment, open the service's **Variables** tab and add the variables in section 4, including `ADMIN_EMAIL` and `ADMIN_PASSWORD`. The admin account is created at first startup, so set these before the first run. If you change the admin email/password later, the existing admin account is not automatically reset. Initially use Paystack **test** credentials.
7. Add a Railway **Volume** to this same service and set its mount path to `/data`. Set `DB_PATH=/data/klearwatt.db`. This is essential: the SQLite database must be on the persistent volume, not the temporary application filesystem.
8. Under the service's **Settings → Networking**, generate a public domain. Set `APP_URL` to that full `https://...` domain with no trailing slash, then review and deploy the staged changes.
9. In Paystack Test-mode webhook settings, set the URL to `https://YOUR-RAILWAY-DOMAIN/api/paystack/webhook`. Add the matching Test-mode webhook signing secret as `PAYSTACK_WEBHOOK_SECRET` in Railway and redeploy if you change it.
10. Open `/account.html` and log in with the admin email/password you configured, then open `/admin.html` and confirm the dashboard says **TEST MODE**. Register a separate test customer in another browser/private window to test customer bookings.

**Persistent database note:** Railway volumes are mounted at the absolute path you choose. If you mount at `/data`, the database path must be `/data/klearwatt.db`. Without a volume, the database file can be lost when the service is redeployed. See Railway's [Volumes guide](https://docs.railway.com/volumes), [Services guide](https://docs.railway.com/services), and [Variables guide](https://docs.railway.com/variables).

---

## 6. How to test (test mode)

1. Deploy, open `/account.html`, log in with the admin email, then open Admin. The banner must say **TEST MODE**.
2. Admin → Service prices: enter your real prices. For Weekly / Every two weeks press **Create Paystack plan**.
3. Register a normal customer in a private window, create a booking. In Admin enter a price for the one-time booking, then as the customer press **Pay now**.
4. On Paystack’s page use test cards from https://paystack.com/docs/payments/test-payments  
   Success card: `4084 0840 8408 4081`, any future expiry, CVV `408`, OTP `123456`.
5. After returning to My Account you should see the result, the receipt and payment history. Admin → All transactions shows it too. Check Paystack webhook logs for status 200.
6. Subscription: pay a Weekly / Every-two-weeks booking. Renewals arrive by webhook monthly in test mode.
7. Click Pay now twice and refresh after paying: only one payment and one receipt must exist.
8. Cash/transfer: Admin → Record cash / bank transfer.

---

## 7. Going live

1. Complete Paystack business verification so live keys appear.
2. Replace `PAYSTACK_SECRET_KEY` with the `'sk' + '_' + 'live' + '_...'` key on the host and redeploy/restart. Admin banner must say **LIVE MODE**.
3. Set the same webhook URL in the **Live** settings and replace `PAYSTACK_WEBHOOK_SECRET` with the matching Live-mode signing secret.
4. Re-create each subscription plan (plans are separate between test and live).
5. Make one small real payment yourself and confirm receipt, status and webhook.
6. Back up the database file regularly.

---

## Quotation requests

The public website includes a residential/commercial quotation form. Requests are stored in the database and visible only to the administrator at `/admin.html`. The admin can review site details, enter a proposed quote and update the request status (new, reviewing, quoted, accepted, declined). The form does not automatically send an email or WhatsApp message; the business contacts the customer using the details supplied. A quotation request is not a confirmed booking and does not create a payment. Large commercial installations and solar farms should be assessed and quoted individually.

## Honest limits

- Subscription cancellation is done in the Paystack Dashboard (Customers → Subscriptions); the site records the cancel event.
- Paystack sends renewals to a card on file; weekly/biweekly visits are billed as one monthly amount, not per visit.
- Password reset by email is not included (no email service). The admin can’t reset passwords from the UI yet.
- Automated tests use a simulated Paystack only. Real card tests must be done by you in Paystack test mode (section 6) before taking customer money.

---

## Project structure

```
klearwatt-solar-care/
├── package.json
├── server.js              # All backend + Paystack + SQLite
├── .env.example
├── public/
│   ├── index.html         # Responsive residential + commercial cleaning website
│   ├── account.html       # Customer My Account
│   ├── admin.html         # Admin dashboard
│   ├── app.css / app.js
│   └── images/
│       └── before-after.jpg   # Photo-style illustrative multi-panel before/after visual
├── test/
│   ├── run.js             # 64 automated tests
│   └── mock-paystack.js
└── README.md
```

---

## Running locally

```bash
cp .env.example .env
# edit .env with your test keys
node server.js
# open http://localhost:3000
npm test   # runs the 64 automated tests
```

---

## Changes made in this finalization

- Corrected service coverage from “Masaka only” to the full Karu LGA list and approved service description on the homepage and booking section.
- Confirmed WhatsApp (09037885738 / wa.me/2349037885738) and telephone (07087942034) are used correctly and never swapped.
- Replaced the old SVG illustration with an optimized JPEG before-and-after comparison of a large multi-panel installation (heavily dusty vs clean and shiny). The image is clearly labelled as promotional/illustrative, not an actual KlearWatt customer job photo.
- Improved mobile layout of the hero section.
- Re-ran the automated suite after these changes; the final count is recorded in the confirmation checklist below.
- Updated README with complete Railway beginner guide, exact environment variable table, and current business details.
- Added current Paystack timestamped webhook signature verification and transaction-reference matching while preserving the existing booking, account and admin workflows.

---

## Confirmation checklist

- [x] WhatsApp number 09037885738 used only for WhatsApp buttons and links
- [x] Telephone 07087942034 used only for Call buttons and tel: links
- [x] Service area correctly described as Karu LGA + listed communities
- [x] Cartoon illustration removed and replaced with multi-panel before/after visual
- [x] 64 automated tests pass against the local mock Paystack
- [x] Project files prepared for GitHub + Railway (subject to owner’s account setup, Paystack credentials and volume configuration)
