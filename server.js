'use strict';
/*
 * Hangberg Educational Trust — online auction
 * Zero-dependency Node.js (22.13+) app: built-in HTTP server, SQLite and crypto.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, tx, getSettings, setSetting, syncCover, UPLOAD_DIR } = require('./src/db');
const auction = require('./src/auction');
const views = require('./src/views');
const mail = require('./src/mail');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE = BASE_URL.startsWith('https://');
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SESSION_DAYS = 30;
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------------- helpers ---------------- */

const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const iso = (msFromNow = 0) => new Date(Date.now() + msFromNow).toISOString();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}
const DUMMY_HASH = hashPassword(token());

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}

// Simple in-memory rate limiter for sensitive forms.
const hits = new Map();
function rateLimited(key, limit = 10, windowMs = 15 * 60e3) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > limit;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.every(t => now - t > 15 * 60e3)) hits.delete(k); }, 60e3).unref();

async function readBody(req, limit = 1e6) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('Too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

async function parseForm(req) {
  const type = req.headers['content-type'] || '';
  if (type.startsWith('multipart/form-data')) {
    const buf = await readBody(req, 60e6);
    const fd = await new Request('http://x/', { method: 'POST', headers: { 'content-type': type }, body: buf }).formData();
    const fields = {}; const files = {};
    for (const [k, v] of fd.entries()) { if (typeof v === 'string') fields[k] = v; else if (v.size) (files[k] ||= []).push(v); }
    return { fields, files };
  }
  const buf = await readBody(req);
  return { fields: Object.fromEntries(new URLSearchParams(buf.toString('utf8'))), files: {} };
}

/* ---------------- sessions ---------------- */

function loadSession(req, res) {
  const sid = parseCookies(req).sid;
  let s = sid && db.prepare('SELECT * FROM sessions WHERE id = ? AND expires > ?').get(sha(sid), iso());
  if (!s) {
    const raw = token();
    db.prepare('INSERT INTO sessions (id, csrf, expires) VALUES (?, ?, ?)').run(sha(raw), token(), iso(SESSION_DAYS * 864e5));
    s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sha(raw));
    res.setHeader('Set-Cookie', `sid=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${SECURE ? '; Secure' : ''}`);
  }
  return s;
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(iso()), 3600e3).unref();

function setFlash(sess, type, msg) {
  db.prepare('UPDATE sessions SET flash = ? WHERE id = ?').run(JSON.stringify({ type, msg }), sess.id);
}

/* ---------------- responses ---------------- */

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}
function redirect(res, to) { res.writeHead(303, { Location: to }); res.end(); }
function safeNext(n) { return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/'; }

const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveFile(res, dir, rel) {
  const file = path.join(dir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
}

function csv(rows) {
  return rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');
}

/* ---------------- emails ---------------- */

function sendConfirmation(user, raw) {
  const url = `${BASE_URL}/confirm?token=${raw}`;
  const s = getSettings();
  const m = mail.wrap('Confirm your email address', [
    `Hi ${user.first_name},`,
    `Thank you for registering for the ${s.event_name} online auction. Please confirm your email address to start bidding. This link is valid for 48 hours.`
  ], { label: 'Confirm my email', url });
  return mail.send({ to: user.email, subject: 'Confirm your email – online auction', ...m });
}

function sendOutbid(userId, item) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) return;
  const m = mail.wrap('You have been outbid', [
    `Hi ${u.first_name},`,
    `Someone has bid more than your maximum on Lot ${item.lot_no}: ${item.title}. The current bid is ${views.R(item.current_price)}.`,
    'If you would still like to win this lot, place a new, higher maximum bid.'
  ], { label: 'Bid again', url: `${BASE_URL}/lot/${item.id}` });
  mail.send({ to: u.email, subject: `Outbid on Lot ${item.lot_no}: ${item.title}`, ...m });
}

/* ---------------- routing ---------------- */

const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, opts });

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'");
  if (SECURE) res.setHeader('Strict-Transport-Security', 'max-age=15552000');

  if (p.startsWith('/static/')) return serveFile(res, PUBLIC_DIR, p.slice(8));
  if (p.startsWith('/uploads/')) return serveFile(res, UPLOAD_DIR, path.basename(p));
  if (p === '/health') return send(res, 200, 'ok', 'text/plain');

  const sess = loadSession(req, res);
  const user = sess.user_id ? db.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0').get(sess.user_id) : null;
  let flash = null;
  if (sess.flash) { flash = JSON.parse(sess.flash); db.prepare('UPDATE sessions SET flash = NULL WHERE id = ?').run(sess.id); }
  const ctx = { req, res, url, sess, user, csrf: sess.csrf, flash, settings: getSettings(), query: url.searchParams };

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = typeof r.pattern === 'string' ? (r.pattern === p ? [] : null) : p.match(r.pattern);
    if (!m) continue;
    if (r.opts.auth && !user) return redirect(res, `/login?next=${encodeURIComponent(p)}`);
    if (r.opts.admin && !(user && user.is_admin)) return send(res, 403, views.message(ctx, 'Not allowed', 'This page is for auction administrators only.'));
    if (req.method === 'POST') {
      const { fields, files } = await parseForm(req);
      const a = Buffer.from(String(fields._csrf || '')), b = Buffer.from(sess.csrf);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(res, 403, views.message(ctx, 'Session expired', 'Please go back, refresh the page and try again.'));
      ctx.body = fields; ctx.files = files;
      if (r.opts.limit && rateLimited(`${r.pattern}:${clientIp(req)}`, r.opts.limit)) {
        return send(res, 429, views.message(ctx, 'Too many attempts', 'Please wait a few minutes and try again.'));
      }
    }
    return r.handler(ctx, ...m.slice(1));
  }
  send(res, 404, views.message(ctx, 'Page not found', 'That page does not exist.', { href: '/', label: 'Back to the auction' }));
}

/* ---------------- public pages ---------------- */

const photosOf = id => db.prepare('SELECT * FROM item_photos WHERE item_id = ? ORDER BY sort, id').all(id);

function itemsFor(user) {
  return db.prepare(`SELECT i.*, EXISTS(SELECT 1 FROM max_bids b WHERE b.item_id = i.id AND b.user_id = ?) AS i_bid
                     FROM items i WHERE visible = 1 ORDER BY lot_no, id`).all(user ? user.id : -1);
}

route('GET', '/', ctx => send(ctx.res, 200, views.home(ctx, itemsFor(ctx.user))));
route('GET', '/how-it-works', ctx => send(ctx.res, 200, views.howItWorks(ctx)));

route('GET', /^\/lot\/(\d+)$/, (ctx, id) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ? AND visible = 1').get(+id);
  if (!item) return send(ctx.res, 404, views.message(ctx, 'Lot not found', 'That lot does not exist.', { href: '/', label: 'All lots' }));
  send(ctx.res, 200, views.lot(ctx, item, auction.history(item.id), photosOf(item.id)));
});

// Live state for polling (prices, bid counts, whether you're leading).
route('GET', '/api/state', ctx => {
  const s = ctx.settings;
  const out = itemsFor(ctx.user).map(i => ({
    id: i.id, price: views.R((() => { const o = auction.result(i, s); return o.state === 'final' && o.winner ? o.price : (i.current_price ?? i.start_bid); })()), bids: i.bid_count,
    status: auction.status(i, s), closes: auction.closeTime(i, s).toISOString(),
    leading: !!(ctx.user && i.leader_id === ctx.user.id)
  }));
  ctx.res.setHeader('Cache-Control', 'no-store');
  send(ctx.res, 200, JSON.stringify(out), 'application/json');
});

route('POST', /^\/lot\/(\d+)\/bid$/, (ctx, id) => {
  if (!ctx.user.confirmed) { setFlash(ctx.sess, 'error', 'Please confirm your email address before bidding.'); return redirect(ctx.res, `/lot/${id}`); }
  const amount = Number(String(ctx.body.amount || '').replace(/[\sR,]/g, ''));
  const r = auction.placeBid(+id, ctx.user.id, amount);
  setFlash(ctx.sess, r.ok ? (r.leading ? 'success' : 'error') : 'error', r.message);
  if (r.outbidUserId) sendOutbid(r.outbidUserId, r.item);
  redirect(ctx.res, `/lot/${id}`);
}, { auth: true, limit: 60 });

route('GET', '/my-bids', ctx => {
  const items = db.prepare(`SELECT i.*, MAX(b.max_amount) AS my_max FROM items i JOIN max_bids b ON b.item_id = i.id
                            WHERE b.user_id = ? GROUP BY i.id ORDER BY i.lot_no`).all(ctx.user.id);
  send(ctx.res, 200, views.myBids(ctx, items));
}, { auth: true });

/* ---------------- accounts ---------------- */

route('GET', '/register', ctx => ctx.user ? redirect(ctx.res, '/') : send(ctx.res, 200, views.register(ctx)));
route('POST', '/register', async ctx => {
  const v = Object.fromEntries(['first_name', 'last_name', 'email', 'phone'].map(k => [k, String(ctx.body[k] || '').trim()]));
  v.email = v.email.toLowerCase();
  const pw = String(ctx.body.password || '');
  let err = null;
  if (!v.first_name || !v.last_name || !v.phone) err = 'Please fill in all the fields.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) || v.email.length > 200) err = 'Please enter a valid email address.';
  else if (!/^[+\d][\d\s()-]{8,}$/.test(v.phone)) err = 'Please enter a valid cellphone number.';
  else if (pw.length < 8) err = 'Your password must be at least 8 characters.';
  else if (pw !== ctx.body.password2) err = 'The two passwords do not match.';
  else if (!ctx.body.terms) err = 'Please confirm that you agree to the bidding rules.';
  if (err) { ctx.flash = { type: 'error', msg: err }; return send(ctx.res, 400, views.register(ctx, v)); }

  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(v.email);
  if (existing) {
    // Don't reveal whether an address is registered; nudge them to log in instead.
    if (!existing.confirmed) {
      const raw = token();
      db.prepare('UPDATE users SET confirm_token = ?, confirm_expires = ? WHERE id = ?').run(sha(raw), iso(48 * 3600e3), existing.id);
      sendConfirmation(existing, raw);
    }
    return send(ctx.res, 200, views.message(ctx, 'Check your email', `If ${v.email} is not yet confirmed, we have sent a confirmation link. If you already have an account, please log in.`, { href: '/login', label: 'Log in' }));
  }
  const raw = token();
  const isAdmin = ADMIN_EMAILS.includes(v.email) ? 1 : 0;
  db.prepare(`INSERT INTO users (first_name, last_name, email, phone, password_hash, confirm_token, confirm_expires, is_admin)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(v.first_name, v.last_name, v.email, v.phone, hashPassword(pw), sha(raw), iso(48 * 3600e3), isAdmin);
  await sendConfirmation(v, raw);
  send(ctx.res, 200, views.message(ctx, 'Check your email', `We've sent a confirmation link to ${v.email}. Click it to activate your account, then you can start bidding. (Check your spam folder if it doesn't arrive in a few minutes.)`));
}, { limit: 10 });

route('GET', '/confirm', ctx => {
  const raw = ctx.query.get('token') || '';
  const u = raw && db.prepare('SELECT * FROM users WHERE confirm_token = ? AND confirm_expires > ?').get(sha(raw), iso());
  if (!u) return send(ctx.res, 400, views.message(ctx, 'Link expired', 'This confirmation link is invalid or has expired.', { href: '/resend', label: 'Send a new link' }));
  db.prepare('UPDATE users SET confirmed = 1, confirm_token = NULL, confirm_expires = NULL WHERE id = ?').run(u.id);
  db.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run(u.id, ctx.sess.id);
  setFlash(ctx.sess, 'success', `Welcome, ${u.first_name}! Your email is confirmed and you're logged in — happy bidding.`);
  redirect(ctx.res, '/');
});

route('GET', '/resend', ctx => send(ctx.res, 200, views.emailOnly(ctx, 'Resend confirmation email', '/resend', 'Enter the email address you registered with.')));
route('POST', '/resend', async ctx => {
  const u = db.prepare('SELECT * FROM users WHERE email = ? AND confirmed = 0').get(String(ctx.body.email || '').trim().toLowerCase());
  if (u) {
    const raw = token();
    db.prepare('UPDATE users SET confirm_token = ?, confirm_expires = ? WHERE id = ?').run(sha(raw), iso(48 * 3600e3), u.id);
    await sendConfirmation(u, raw);
  }
  send(ctx.res, 200, views.message(ctx, 'Check your email', 'If that address is registered and not yet confirmed, a new confirmation link is on its way.'));
}, { limit: 5 });

route('GET', '/login', ctx => ctx.user ? redirect(ctx.res, '/') : send(ctx.res, 200, views.login(ctx, ctx.query.get('next') || '')));
route('POST', '/login', ctx => {
  const email = String(ctx.body.email || '').trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = verifyPassword(String(ctx.body.password || ''), u ? u.password_hash : DUMMY_HASH) && u;
  if (!ok || u.disabled) {
    ctx.flash = { type: 'error', msg: u && u.disabled ? 'This account has been disabled. Please contact the organisers.' : 'Incorrect email or password.' };
    return send(ctx.res, 401, views.login(ctx, ctx.body.next, email));
  }
  if (!u.confirmed) {
    ctx.flash = { type: 'error', msg: 'Please confirm your email address first — check your inbox for the link, or request a new one below.' };
    return send(ctx.res, 401, views.login(ctx, ctx.body.next, email));
  }
  if (ADMIN_EMAILS.includes(u.email.toLowerCase()) && !u.is_admin) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(u.id);
  // Rotate session id on login.
  const raw = token();
  db.prepare('UPDATE sessions SET id = ?, user_id = ?, csrf = ? WHERE id = ?').run(sha(raw), u.id, token(), ctx.sess.id);
  ctx.res.setHeader('Set-Cookie', `sid=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${SECURE ? '; Secure' : ''}`);
  redirect(ctx.res, safeNext(ctx.body.next));
}, { limit: 20 });

route('POST', '/logout', ctx => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(ctx.sess.id);
  ctx.res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  redirect(ctx.res, '/');
});

route('GET', '/forgot', ctx => send(ctx.res, 200, views.emailOnly(ctx, 'Reset your password', '/forgot', "Enter your email address and we'll send you a link to choose a new password.")));
route('POST', '/forgot', async ctx => {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(ctx.body.email || '').trim().toLowerCase());
  if (u) {
    const raw = token();
    db.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?').run(sha(raw), iso(3600e3), u.id);
    const m = mail.wrap('Reset your password', [`Hi ${u.first_name},`, 'Someone (hopefully you) asked to reset your auction password. This link is valid for 1 hour. If you did not ask for this, you can ignore this email.'],
      { label: 'Choose a new password', url: `${BASE_URL}/reset?token=${raw}` });
    await mail.send({ to: u.email, subject: 'Reset your auction password', ...m });
  }
  send(ctx.res, 200, views.message(ctx, 'Check your email', 'If that address is registered, a password reset link is on its way.'));
}, { limit: 5 });

route('GET', '/reset', ctx => send(ctx.res, 200, views.reset(ctx, ctx.query.get('token') || '')));
route('POST', '/reset', ctx => {
  const raw = String(ctx.body.token || '');
  const u = raw && db.prepare('SELECT * FROM users WHERE reset_token = ? AND reset_expires > ?').get(sha(raw), iso());
  if (!u) return send(ctx.res, 400, views.message(ctx, 'Link expired', 'This reset link is invalid or has expired.', { href: '/forgot', label: 'Send a new link' }));
  const pw = String(ctx.body.password || '');
  if (pw.length < 8 || pw !== ctx.body.password2) { ctx.flash = { type: 'error', msg: 'Passwords must match and be at least 8 characters.' }; return send(ctx.res, 400, views.reset(ctx, raw)); }
  tx(() => {
    db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL, confirmed = 1 WHERE id = ?').run(hashPassword(pw), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); // log out everywhere
  });
  setFlash(loadSession(ctx.req, ctx.res), 'success', 'Password changed. Please log in.');
  redirect(ctx.res, '/login');
}, { limit: 10 });

/* ---------------- admin ---------------- */

const A = { auth: true, admin: true };

route('GET', '/admin', ctx => {
  const q = sql => db.prepare(sql).get().n;
  send(ctx.res, 200, views.adminHome(ctx, {
    total: q('SELECT COALESCE(SUM(current_price),0) AS n FROM items WHERE leader_id IS NOT NULL'),
    items: q('SELECT COUNT(*) AS n FROM items'),
    withBids: q('SELECT COUNT(*) AS n FROM items WHERE leader_id IS NOT NULL'),
    users: q('SELECT COUNT(*) AS n FROM users'),
    confirmed: q('SELECT COUNT(*) AS n FROM users WHERE confirmed = 1'),
    bids: q('SELECT COUNT(*) AS n FROM max_bids')
  }));
}, A);

route('GET', '/admin/items', ctx => {
  const items = db.prepare(`SELECT i.*, u.first_name || ' ' || u.last_name AS leader_name FROM items i LEFT JOIN users u ON u.id = i.leader_id ORDER BY lot_no, i.id`).all();
  send(ctx.res, 200, views.adminItems(ctx, items));
}, A);

route('GET', '/admin/items/new', ctx => {
  const next = db.prepare('SELECT COALESCE(MAX(lot_no),0)+1 AS n FROM items').get().n;
  send(ctx.res, 200, views.adminItem(ctx, { lot_no: next, title: '', description: '', donor: '', value_note: '', start_bid: 500, increment: 50, visible: 1, mode: 'online' }));
}, A);

route('GET', /^\/admin\/items\/(\d+)$/, (ctx, id) => {
  const it = db.prepare('SELECT * FROM items WHERE id = ?').get(+id);
  if (!it) return redirect(ctx.res, '/admin/items');
  const bids = db.prepare(`SELECT b.*, u.first_name, u.last_name, u.email, u.phone FROM max_bids b JOIN users u ON u.id = b.user_id WHERE item_id = ? ORDER BY b.id DESC`).all(it.id);
  send(ctx.res, 200, views.adminItem(ctx, it, bids, photosOf(it.id)));
}, A);

async function saveImage(file) {
  if (!file) return null;
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[file.type];
  if (!ext) throw new Error('Photos must be JPG, PNG or WebP.');
  if (file.size > 12e6) throw new Error('Each photo must be smaller than 12 MB.');
  const name = token(12) + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(await file.arrayBuffer()));
  return name;
}
const sastToIso = v => (v ? new Date(`${v}:00+02:00`).toISOString() : null);

route('POST', /^\/admin\/items\/(new|\d+)$/, async (ctx, id) => {
  const b = ctx.body;
  const data = {
    lot_no: parseInt(b.lot_no, 10), title: String(b.title || '').trim(), description: String(b.description || '').trim(),
    donor: String(b.donor || '').trim(), value_note: String(b.value_note || '').trim(),
    start_bid: parseInt(b.start_bid, 10), increment: parseInt(b.increment, 10), mode: b.mode === 'live' ? 'live' : 'online',
    link: /^https?:\/\/\S+$/i.test(String(b.link || '').trim()) ? String(b.link).trim() : null,
    closes_at: sastToIso(b.closes_at), visible: b.visible ? 1 : 0
  };
  if (!data.title || !(data.lot_no > 0) || !(data.start_bid > 0) || !(data.increment > 0)) {
    setFlash(ctx.sess, 'error', 'Lot number, title, minimum opening bid and bid increment are required.');
    return redirect(ctx.res, `/admin/items/${id}`);
  }
  let photos = [], logo = null;
  try {
    for (const f of ctx.files.photos || []) photos.push(await saveImage(f));
    if (ctx.files.logo) logo = await saveImage(ctx.files.logo[0]);
  } catch (e) { setFlash(ctx.sess, 'error', e.message); return redirect(ctx.res, `/admin/items/${id}`); }
  let itemId = +id;
  if (id === 'new') {
    itemId = Number(db.prepare(`INSERT INTO items (lot_no, title, description, donor, value_note, start_bid, increment, closes_at, visible, logo, mode, link)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(data.lot_no, data.title, data.description, data.donor, data.value_note, data.start_bid, data.increment, data.closes_at, data.visible, logo, data.mode, data.link).lastInsertRowid);
  } else {
    tx(() => {
      db.prepare(`UPDATE items SET lot_no=?, title=?, description=?, donor=?, value_note=?, start_bid=?, increment=?, closes_at=?, visible=?, mode=?, link=? WHERE id=?`)
        .run(data.lot_no, data.title, data.description, data.donor, data.value_note, data.start_bid, data.increment, data.closes_at, data.visible, data.mode, data.link, itemId);
      if (logo) db.prepare('UPDATE items SET logo = ? WHERE id = ?').run(logo, itemId);
      auction.recompute(itemId);
    });
  }
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM item_photos WHERE item_id = ?').get(itemId).m;
  photos.forEach((f, i) => db.prepare('INSERT INTO item_photos (item_id, file, sort) VALUES (?, ?, ?)').run(itemId, f, maxSort + 1 + i));
  syncCover(itemId);
  setFlash(ctx.sess, 'success', `Lot saved.${photos.length ? ` ${photos.length} photo${photos.length === 1 ? '' : 's'} added.` : ''}`);
  redirect(ctx.res, `/admin/items/${itemId}`);
}, A);

route('POST', /^\/admin\/photos\/(\d+)\/(delete|first)$/, (ctx, id, action) => {
  const ph = db.prepare('SELECT * FROM item_photos WHERE id = ?').get(+id);
  if (!ph) return redirect(ctx.res, '/admin/items');
  if (action === 'delete') db.prepare('DELETE FROM item_photos WHERE id = ?').run(ph.id);
  else db.prepare('UPDATE item_photos SET sort = (SELECT MIN(sort) - 1 FROM item_photos WHERE item_id = ?) WHERE id = ?').run(ph.item_id, ph.id);
  syncCover(ph.item_id);
  redirect(ctx.res, `/admin/items/${ph.item_id}`);
}, A);

route('POST', /^\/admin\/items\/(\d+)\/remove-logo$/, (ctx, id) => {
  db.prepare('UPDATE items SET logo = NULL WHERE id = ?').run(+id);
  redirect(ctx.res, `/admin/items/${id}`);
}, A);

route('POST', /^\/admin\/items\/(\d+)\/delete$/, (ctx, id) => {
  db.prepare('DELETE FROM items WHERE id = ? AND bid_count = 0').run(+id);
  setFlash(ctx.sess, 'success', 'Lot deleted.');
  redirect(ctx.res, '/admin/items');
}, A);

route('POST', /^\/admin\/bids\/(\d+)\/delete$/, (ctx, id) => {
  const itemId = auction.removeMaxBid(+id);
  setFlash(ctx.sess, 'success', 'Bid removed and the lot recalculated.');
  redirect(ctx.res, itemId ? `/admin/items/${itemId}` : '/admin/items');
}, A);

route('GET', '/admin/bidders', ctx => {
  const users = db.prepare('SELECT u.*, (SELECT COUNT(*) FROM max_bids b WHERE b.user_id = u.id) AS bids FROM users u ORDER BY u.id').all();
  send(ctx.res, 200, views.adminBidders(ctx, users));
}, A);

route('GET', '/admin/bidders.csv', ctx => {
  const users = db.prepare('SELECT * FROM users ORDER BY id').all();
  ctx.res.setHeader('Content-Disposition', 'attachment; filename="bidders.csv"');
  send(ctx.res, 200, csv([['Bidder no.', 'First name', 'Surname', 'Email', 'Cell', 'Confirmed', 'Registered'],
    ...users.map(u => [1000 + u.id, u.first_name, u.last_name, u.email, u.phone, u.confirmed ? 'Yes' : 'No', u.created_at])]), 'text/csv; charset=utf-8');
}, A);

route('POST', /^\/admin\/bidders\/(\d+)\/toggle$/, (ctx, id) => {
  db.prepare('UPDATE users SET disabled = 1 - disabled WHERE id = ? AND is_admin = 0').run(+id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(+id);
  redirect(ctx.res, '/admin/bidders');
}, A);

route('POST', /^\/admin\/bidders\/(\d+)\/confirm$/, (ctx, id) => {
  db.prepare('UPDATE users SET confirmed = 1, confirm_token = NULL WHERE id = ?').run(+id);
  redirect(ctx.res, '/admin/bidders');
}, A);

const resultsQuery = `SELECT i.*, u.first_name, u.last_name, u.email, u.phone FROM items i LEFT JOIN users u ON u.id = i.leader_id ORDER BY i.lot_no, i.id`;
route('GET', '/admin/results', ctx => send(ctx.res, 200, views.adminResults(ctx, db.prepare(resultsQuery).all())), A);
route('GET', '/admin/results.csv', ctx => {
  const rows = db.prepare(resultsQuery).all();
  const s = ctx.settings;
  ctx.res.setHeader('Content-Disposition', 'attachment; filename="auction-results.csv"');
  send(ctx.res, 200, csv([['Lot', 'Title', 'Type', 'Donor', 'Status', 'Winning bid (R)', 'Winner', 'Won', 'Email', 'Cell', 'Bidder no.'],
    ...rows.map(r => {
      const o = auction.result(r, s);
      const fin = o.state === 'final';
      const online = fin && o.winner === 'online';
      return [r.lot_no, r.title, r.mode === 'live' ? 'Online-to-live' : 'Online only', r.donor,
        { open: 'Open', upcoming: 'Not open', awaiting_live: 'Awaiting live auction', final: 'Final' }[o.state],
        fin && o.winner ? o.price : '', online ? `${r.first_name} ${r.last_name}` : o.winner === 'room' ? (r.room_bidder || 'Room bidder') : '',
        online ? 'Online' : o.winner === 'room' ? 'At the dinner' : '', online ? r.email : '', online ? r.phone : '', online ? 1000 + r.leader_id : ''];
    })]), 'text/csv; charset=utf-8');
}, A);

route('GET', '/admin/live', ctx => {
  const rows = db.prepare(`SELECT i.*, u.first_name, u.last_name, u.email, u.phone FROM items i LEFT JOIN users u ON u.id = i.leader_id
                           WHERE i.mode = 'live' ORDER BY i.lot_no, i.id`).all();
  send(ctx.res, 200, views.liveSheet(ctx, rows));
}, A);

route('POST', /^\/admin\/live\/(\d+)$/, (ctx, id) => {
  const raw = String(ctx.body.room_bid || '').replace(/[\sR,]/g, '');
  const roomBid = raw === '' ? null : parseInt(raw, 10);
  if (raw !== '' && !(roomBid >= 0)) { setFlash(ctx.sess, 'error', 'Please enter the room bid as a whole rand amount.'); return redirect(ctx.res, '/admin/live'); }
  db.prepare('UPDATE items SET room_bid = ?, room_bidder = ?, live_done = 1 WHERE id = ? AND mode = ?')
    .run(roomBid, String(ctx.body.room_bidder || '').trim(), +id, 'live');
  setFlash(ctx.sess, 'success', 'Live result recorded.');
  redirect(ctx.res, `/admin/live#lot-${id}`);
}, A);

route('POST', '/admin/notify-winners', async ctx => {
  const s = ctx.settings;
  const rows = db.prepare(`${resultsQuery.replace('ORDER BY', 'WHERE i.leader_id IS NOT NULL AND i.winner_notified = 0 ORDER BY')}`).all()
    .map(r => ({ ...r, outcome: auction.result(r, s) }))
    .filter(r => r.outcome.state === 'final' && r.outcome.winner === 'online');
  let sent = 0;
  for (const r of rows) {
    const m = mail.wrap('Congratulations — you won!', [
      `Hi ${r.first_name},`,
      `Congratulations! You are the winning bidder for Lot ${r.lot_no}: ${r.title}, at ${views.R(r.outcome.price)}.`,
      s.payment_info,
      `Thank you for supporting the ${s.event_name}.`
    ]);
    if (await mail.send({ to: r.email, subject: `You won Lot ${r.lot_no}: ${r.title}`, ...m })) {
      db.prepare('UPDATE items SET winner_notified = 1 WHERE id = ?').run(r.id); sent++;
    }
  }
  setFlash(ctx.sess, 'success', `Emailed ${sent} winner${sent === 1 ? '' : 's'}.`);
  redirect(ctx.res, '/admin/results');
}, A);

route('GET', '/admin/settings', ctx => send(ctx.res, 200, views.adminSettings(ctx)), A);
route('POST', '/admin/settings', ctx => {
  const b = ctx.body;
  for (const k of ['event_name', 'event_date', 'intro', 'payment_info', 'contact_email']) setSetting(k, String(b[k] || '').trim());
  if (b.opens_at) setSetting('opens_at', sastToIso(b.opens_at));
  for (const k of ['live_closes_at', 'online_closes_at']) if (b[k]) setSetting(k, sastToIso(b[k]));
  setSetting('extend_minutes', Math.max(0, Math.min(30, parseInt(b.extend_minutes, 10) || 0)));
  setFlash(ctx.sess, 'success', 'Settings saved.');
  redirect(ctx.res, '/admin/settings');
}, A);

/* ---------------- start ---------------- */

http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) send(res, err.status || 500, err.status === 413 ? 'Upload too large' : 'Something went wrong. Please try again.', 'text/plain');
  });
}).listen(PORT, () => console.log(`Auction running at ${BASE_URL} (port ${PORT})`));
