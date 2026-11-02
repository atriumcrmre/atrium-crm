# Atrium CRM

A real-estate CRM for residential and commercial teams. It has two parts:

- **Node.js backend:** Express, PostgreSQL, user accounts and teams, and a background sync worker.
- **Glass web app:** contacts, companies, deals and tickets; campaigns, marketing email, forms and landing pages; inbox and calendar; listings; integrations; and the Keystone AI assistant.

| Area | What's real |
|---|---|
| Accounts | Email/password and **Google or Microsoft sign-in**, teams with invite links, admin/member roles, encrypted session cookies |
| Database | PostgreSQL. All CRM records are shared by the team and saved as you work |
| Mail sync | **Gmail** (Gmail API, incremental via historyId) and **Outlook / Microsoft 365** (Graph delta). Checks every minute. Emails with known contacts are logged to their timelines automatically. Replies send from your own address |
| Calendar sync | **Google Calendar** and **Outlook Calendar**, both directions. Meetings booked in Atrium are created on your calendar with invites (Meet or Teams links), and cancelled meetings are removed |
| Marketing email | **SendGrid**: per-recipient personalization, scheduled sends, open and click tracking, bounces and unsubscribes (one-click List-Unsubscribe) |
| Landing pages | **Netlify**: publishing deploys the page to your team's Netlify site, and its form posts straight into the CRM |
| Forms | Public form API with validation, a honeypot and rate limits. Submissions create or update contacts, log activity and create follow-up tasks. You can also copy an embed code for any website |
| Zillow | Lead delivery URL for Premier Agent: each lead becomes a contact, a deal and a call task. **Bridge** (Zillow Group) MLS listings sync hourly |
| CoStar | Import CoStar tenant and property exports (CSV): companies with lease expirations and square footage, contacts and properties |
| DocuSign | Send a PDF or template for signature from any deal. Signing status comes back to the deal timeline |
| Open platform | REST API with API keys, plus signed outbound webhooks for 13 events (works with Zapier, Make, n8n or your own code) |
| Keystone AI | **Google Gemini** (free tier available) or Claude, chosen with one setting; the key stays on the server. It can read, create and update records, send email, schedule meetings and build marketing assets |

## Quick start

With Docker:

```bash
cp .env.example .env
npm run gen:keys            # paste the two lines into .env
docker compose up --build   # Postgres + app on http://localhost:4000
```

Without Docker (Node 20+ and a PostgreSQL 14+ database):

```bash
npm install
cp .env.example .env        # set DATABASE_URL, and paste the output of: npm run gen:keys
npm run migrate
npm start                   # http://localhost:4000
```

Open the app, create an account, then use **Load sample data** on the dashboard to explore. Each provider below is optional; until one is set up, the app shows a clear "not configured" message in that spot.

## Provider setup

All callback URLs below use `APP_URL`. In production it must be `https://`.

### Google (sign-in, Gmail, Google Calendar)
1. In Google Cloud Console, create a project and enable the **Gmail API** and the **Google Calendar API**.
2. Under **OAuth consent screen**, add these scopes: `gmail.readonly`, `gmail.send`, `calendar.events`, `openid`, `email`, `profile`.
3. Under **Credentials**, create an **OAuth client ID** of type *Web application*.
   - Authorized redirect URI: `APP_URL/api/oauth/google/callback`
4. Put the client ID and secret in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

> **Important:** `gmail.readonly` is a *restricted* scope.
> - **Internal app:** if only people in your own Google Workspace use Atrium, mark the app *Internal* and no review is needed.
> - **External users:** Google requires app verification and an annual third-party security assessment.
> - **Testing mode:** limited to 100 test users, and their sign-ins expire after 7 days.

### Microsoft 365 (sign-in, Outlook mail, Outlook Calendar)
1. In Microsoft Entra admin center, go to **App registrations** and choose **New registration**.
   - Account types: *Any organizational directory and personal Microsoft accounts* (to match `MICROSOFT_TENANT=common`). Use your tenant ID instead to restrict sign-in to your company.
   - Redirect URI (Web): `APP_URL/api/oauth/microsoft/callback`
2. Under **Certificates & secrets**, create a client secret.
3. Under **API permissions**, add these *Microsoft Graph delegated* permissions: `User.Read`, `Mail.Read`, `Mail.Send`, `Calendars.ReadWrite`, `offline_access`, `openid`, `profile`, `email`.
4. Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`.

### SendGrid (marketing email)
1. Authenticate your sending domain (Settings → Sender Authentication).
2. Create an API key with **Mail Send** permission, then set `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` and `SENDGRID_FROM_NAME`.
3. Set up the Event Webhook (Settings → Mail Settings → Event Webhook):
   - URL: `PUBLIC_API_URL/webhooks/sendgrid`
   - Events: Delivered, Opened, Clicked, Bounced, Dropped, Unsubscribe, Spam Report.
   - Turn on **Signed Event Webhook** and paste its public key into `SENDGRID_WEBHOOK_PUBLIC_KEY`.
4. Set `COMPANY_POSTAL_ADDRESS`. It appears in every email footer, as anti-spam laws require.

Contact lists (Active buyers, Past clients, Private investors, …) are built from your live contact data when you send.

### Netlify (landing pages)
Create a personal access token (Netlify → User settings → Applications). Either set `NETLIFY_AUTH_TOKEN` for the whole server, or paste the token per team under **Integrations → Netlify**.
- The first publish creates a site and later publishes redeploy it.
- Pages live at `https://<site>.netlify.app/<slug>/`.
- To use your own domain, add it in Netlify.

### Zillow
- **Leads:** under **Integrations → Zillow Premier Agent**, choose **Turn on** to get a secret lead-delivery URL. Register it with Zillow's lead routing for CRMs. This requires a Premier Agent account, and Zillow controls access to partner lead delivery. The endpoint accepts Zillow's JSON lead shapes. Each lead creates a contact, a deal and a call task.
- **Listings:** apply for access at bridgedataoutput.com (Bridge Interactive, part of Zillow Group); your MLS must approve the feed. Enter the dataset ID and server token under **Integrations → MLS listings (Bridge)**. Listings sync hourly, or on demand with **Sync listings**.

### CoStar
CoStar has no public self-serve API. Export a **tenant** report or a **property** report from CoStar as CSV, then upload it under **Integrations → CoStar**.
- Tenant reports create companies, with lease expirations and square footage.
- If the report has contact columns, those people become contacts.
- Property reports create commercial listings.
- Re-importing the same report updates records instead of duplicating them.

If your firm has an enterprise CoStar data feed, it can be added in `src/services/costar.js`.

### DocuSign
1. Create a developer account. Under **Apps and Keys**, create an integration key.
2. Add an RSA key pair to it, and add `APP_URL` as a redirect URI.
3. Note the **User ID** and **API Account ID**.
4. Enter these under **Integrations → DocuSign** (or in the `DOCUSIGN_*` variables).
5. The first send returns a one-time consent link; open it once.
6. To use DocuSign for real signatures, complete DocuSign's go-live review, then switch the environment to Production.

Envelopes report status back automatically. Optionally set `DOCUSIGN_CONNECT_HMAC_KEY` to verify those callbacks.

### Keystone AI (Google Gemini)
1. Create a free API key in Google AI Studio (aistudio.google.com/apikey).
2. Set `AI_PROVIDER=gemini` and `GEMINI_API_KEY`. `GEMINI_MODEL` defaults to `gemini-2.5-flash`; any Gemini model with function calling works.

**Things to know about the free tier:**
- **Your data:** outside the EEA, Switzerland and the UK, Google may use free-tier prompts and responses to improve its products, and human reviewers may read them. Keystone sends CRM details (names, emails, deal notes) with each request. To keep that data out of training, turn on billing for the Google Cloud project; paid-tier data isn't used to improve Google products.
- **Limits:** the free tier has per-minute and per-day request limits. When a limit is hit, Keystone shows a message and the rest of the CRM keeps working.

To use Claude instead, set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Without any key, Keystone still answers common questions from built-in rules, but it can't write copy or take open-ended actions.

## REST API and webhooks

Create keys under **Integrations → API keys**. All requests use `Authorization: Bearer atr_live_…`.

```
GET    /v1/objects/{type}?unit=res|com&limit=100&after={id}
GET    /v1/objects/{type}/{id}
POST   /v1/objects/{type}        {"unit":"res","properties":{...}}
PATCH  /v1/objects/{type}/{id}   {"properties":{...}}
DELETE /v1/objects/{type}/{id}
GET    /v1/search?q=northwind
```

Types: `contacts`, `companies`, `deals`, `tickets`, `tasks`, `properties`, `campaigns`, `emails`, `forms`, `pages`, `events`.

**Webhooks** are available for these events:
- `contact.created`, `contact.updated`, `company.created`
- `deal.created`, `deal.stage_changed`, `deal.won`
- `ticket.created`, `ticket.status_changed`
- `form.submitted`, `email.opened`, `email.clicked`
- `meeting.booked`, `envelope.completed`

Each delivery carries `X-Atrium-Signature: sha256=<HMAC of "timestamp.body">` using the webhook's secret. Failed deliveries are retried up to three times.

## Deploying

The app is one Node process: the API, the web app and the background worker. It needs PostgreSQL. Good hosts for it:
- Render (a web service plus Render Postgres)
- Railway
- Fly.io
- Any VPS running the included `Dockerfile`, which runs migrations on start

Netlify hosts only the landing pages; the CRM itself needs a Node host. Set `APP_URL` and `PUBLIC_API_URL` to the HTTPS address. Back up the database daily.

## Tests

```bash
BASE=http://localhost:4000 npm run test:smoke   # 34 end-to-end API checks against a running server
npm run test:providers                          # Gmail, Outlook, Google Calendar, SendGrid, Netlify, DocuSign, Bridge and Gemini against mocked APIs
```

## Known limits and next steps

- **Sync timing:** mail and calendar sync check every minute, and the app refreshes every 15 seconds. Gmail Pub/Sub push and Graph change notifications would make this near-instant.
- **What syncs:** one Google and one Microsoft account per user. Attachments aren't synced, and email bodies are stored as plain text. IMAP mailboxes aren't supported yet.
- **Concurrent edits:** if two people edit the same record at once, the last save wins.
- **Workers:** the sync worker runs inside the web process. At larger scale, run it as a separate process (`DISABLE_WORKER=true` on web instances) with a job queue.
- **Sending reputation:** marketing email quality depends on your SendGrid domain authentication and list hygiene.
