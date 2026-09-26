# Hangberg Educational Trust – Online Auction

A small, self-contained auction website for the dinner dance on **9 October 2026**.

**Two kinds of lots**
- **Online-to-live**: online bidding closes **Thu 8 Oct 2026, 20:00 SAST**. The highest online bid is the opening bid at the live auction at the dinner (9 Oct). The top online bidder's maximum stays in play: if the room doesn't go above it, they win at one increment above the room's highest bid (capped at their maximum).
- **Online only**: bidding closes **Sun 11 Oct 2026, 20:00 SAST**. Highest online bid wins.

**What bidders get**
- Register with name, email, cellphone and a password, then confirm via an emailed link
- Browse lots (photo, description, donor, starting bid, increment, countdown)
- **Proxy bidding**: enter the most you're willing to pay; the system bids for you one increment at a time (R50 / R250 / R500 per lot) until your maximum is reached
- Email when someone outbids your maximum
- "My bids" page showing Winning / Outbid / Won
- Prices refresh on screen every 15 seconds; forgot-password flow

**What organisers get (Admin)**
- Add/edit lots with photos, starting bid, increment, optional per-lot closing time, hide/show
- **Live auction sheet**: printable page for the auctioneer (opening bid, top online bidder, confidential maximum); enter the room's highest bid on the night and the site works out the winner
- Set opening time and the two closing times, welcome text, payment info, optional anti-sniping extension
- See every bidder's maximum and contact details, remove a bid (the lot recalculates)
- Bidder list (block / confirm manually), CSV exports of bidders and results
- One-click "Email winners of closed lots"

No third-party packages: it runs on Node.js 22.13 or newer using Node's built-in SQLite.

---

## 1. Try it on your own computer (optional)

1. Install Node.js 22 LTS from https://nodejs.org
2. In this folder run: `ADMIN_EMAILS=you@example.org npm start` (Windows PowerShell: `$env:ADMIN_EMAILS="you@example.org"; npm start`)
3. Open http://localhost:3000, register with that email. With no email service configured, the confirmation link is **printed in the terminal**. Paste it into your browser.
4. You're now an admin: click **Admin** in the menu.

## 2. Set up email (Brevo, free)

1. Create a free account at https://www.brevo.com (300 emails/day free).
2. **Senders & IP → Senders**: add and verify the address emails should come from (e.g. `auction@yourdomain.co.za`). Ideally also authenticate your domain (**Domains** → add the DNS records it shows you) so emails don't land in spam.
3. **SMTP & API → API keys**: create a key. You'll paste it as `BREVO_API_KEY` below.

(Resend.com works too: set `RESEND_API_KEY` instead.)

## 3. Put it online (Railway, about US$5/month)

1. Create a GitHub account and a new **private** repository; upload the contents of this folder.
2. Sign up at https://railway.com → **New Project → Deploy from GitHub repo** → choose the repository.
3. In the service, open **Settings → Volumes → Add volume**, mount path `/data`. (This keeps the database and photos safe across restarts. Don't skip it.)
4. **Variables** — add:
   | Name | Value |
   |---|---|
   | `DATA_DIR` | `/data` |
   | `BASE_URL` | your site address, e.g. `https://hangberg-auction.up.railway.app` |
   | `ADMIN_EMAILS` | your email (comma-separate several organisers) |
   | `MAIL_FROM_EMAIL` | the verified sender address from step 2 |
   | `MAIL_FROM_NAME` | `Hangberg Educational Trust Auction` |
   | `BREVO_API_KEY` | your Brevo key |
5. **Settings → Networking → Generate domain** (or add your own, e.g. `auction.hangbergtrust.org.za`). Make sure `BASE_URL` matches exactly.
6. Open the site, register with your admin email, confirm, then go to **Admin**.

Render.com also works (Web Service + a Persistent Disk mounted at `/data`, paid plan needed for the disk).

## 4. Before the auction opens

- [ ] **Admin → Settings**: check the opening time (default 1 Oct 08:00) and the two closing times, welcome text, payment & collection info, contact email
- [ ] **Admin → Lots**: check every lot (type, starting bid, increment, photo). If the real lots were loaded from `seed/items.json`, there are no placeholders to remove
- [ ] Do a test run with two email addresses: register, confirm, bid against each other, check the outbid email arrives (and isn't in spam)
- [ ] Remove your test bids (Admin → Lots → the lot → Remove) so the auction starts clean
- [ ] Share the link (and a QR code for the tables on the night)

## 5. On the night (9 Oct)

- Open **Admin → Live auction** and print it for the auctioneer. Online maximums are confidential.
- After each live lot, enter the room's highest bid (leave blank if nobody in the room bid) and the room bidder's details. The site shows who won and at what price.

## 6. After it closes

- **Admin → Results**: total raised, winners with contact details, CSV download
- Click **Email online winners of final lots** to send each winner their congratulations + payment info

## How the proxy bidding works (for reference)

Each bidder's maximum is stored privately. The visible current bid is one increment above the second-highest maximum (never above the leader's maximum). If two bidders enter the same maximum, the earlier one leads. Example with R50 increments: current bid R250, you enter R1 000 → you lead at R300. Someone enters R650 → the system bids R700 for you. At the live auction, if your online maximum is R5 000 and the room stops at R3 000 (R50 increments), you win at R3 050.

## Notes

- All times are South African time (UTC+2).
- Only the admin sees bidders' names and maximums; the public bid history shows "Bidder 1001", etc.
- Backups: download **Admin → Results CSV** and **Bidders CSV** periodically on the night; Railway volumes can also be backed up from the dashboard.

## Loading the lot list

On first start the site loads `seed/items.json` (and photos from `seed/photos/`) if present, otherwise a few placeholder lots. Each entry: `{"lot_no", "title", "description", "donor", "value_note", "start_bid", "increment", "mode": "live"|"online", "images": ["lot-07.jpg", "lot-07-2.jpg"], "logo": "logo-07.png"}`. Logos go in `seed/logos/`.

## Photos and logos

Each lot can have several photos (the first is shown on the lot card; bidders can flick through the rest) and one donor/sponsor logo. In Admin → Lots you can add photos, choose the main one, remove photos, and upload or remove the logo.

`tools/standardise_photos.py` prepares them (needs Python + Pillow): photos become 1200 × 900, cropped to fill, upright and gently enhanced; `--logos` trims and fits logos without cropping. It also writes a contact sheet and a report flagging photos to double-check.
