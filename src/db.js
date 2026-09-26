'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'auction.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  confirm_token TEXT,
  confirm_expires TEXT,
  reset_token TEXT,
  reset_expires TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  lot_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  donor TEXT NOT NULL DEFAULT '',
  value_note TEXT NOT NULL DEFAULT '',
  image TEXT,
  start_bid INTEGER NOT NULL,
  increment INTEGER NOT NULL,
  closes_at TEXT,
  visible INTEGER NOT NULL DEFAULT 1,
  -- cached state, always re-derived from max_bids by auction.recompute()
  current_price INTEGER,
  leader_id INTEGER REFERENCES users(id),
  leader_max INTEGER,
  bid_count INTEGER NOT NULL DEFAULT 0,
  winner_notified INTEGER NOT NULL DEFAULT 0
);

-- Every "maximum bid" a bidder submits. The visible bid history is derived from these.
CREATE TABLE IF NOT EXISTS max_bids (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  max_amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS max_bids_item ON max_bids(item_id, id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  flash TEXT,
  expires TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const DEFAULT_SETTINGS = {
  event_name: 'Hangberg Educational Trust Dinner Dance',
  event_date: '9 October 2026',
  // Stored in UTC (SAST = UTC+2).
  opens_at: '2026-10-01T06:00:00.000Z',        // 1 Oct 2026 08:00 SAST (change in Admin → Settings)
  live_closes_at: '2026-10-08T18:00:00.000Z',  // 8 Oct 2026 20:00 SAST: online bidding on online-to-live lots
  online_closes_at: '2026-10-11T18:00:00.000Z',// 11 Oct 2026 20:00 SAST: online-only lots
  extend_minutes: '0',
  intro: 'Welcome to the online auction in support of the Hangberg Educational Trust. Every rand raised goes towards education in our community. Register, browse the lots and bid generously!',
  contact_email: '',
  payment_info: 'Winning bidders will be contacted after the auction with payment and collection details.'
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// Columns added after the first version (safe to run on an existing database).
const cols = db.prepare("PRAGMA table_info(items)").all().map(c => c.name);
const addCol = (name, def) => { if (!cols.includes(name)) db.exec(`ALTER TABLE items ADD COLUMN ${name} ${def}`); };
addCol('mode', "TEXT NOT NULL DEFAULT 'online'");   // 'online' = online only, 'live' = online-to-live
addCol('room_bid', 'INTEGER');                        // highest bid from the room at the live auction
addCol('room_bidder', 'TEXT');                        // room bidder name / paddle number / contact
addCol('live_done', 'INTEGER NOT NULL DEFAULT 0');    // live result recorded
addCol('logo', 'TEXT');                               // donor / sponsor logo (file in uploads)
addCol('link', 'TEXT');                               // donor website / Instagram

// Several photos per lot. items.image always mirrors the first photo (used on the lot cards).
db.exec(`CREATE TABLE IF NOT EXISTS item_photos (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
)`);
db.exec(`INSERT INTO item_photos (item_id, file, sort)
         SELECT id, image, 0 FROM items WHERE image IS NOT NULL AND id NOT IN (SELECT item_id FROM item_photos)`);

function syncCover(itemId) {
  const first = db.prepare('SELECT file FROM item_photos WHERE item_id = ? ORDER BY sort, id LIMIT 1').get(itemId);
  db.prepare('UPDATE items SET image = ? WHERE id = ?').run(first ? first.file : null, itemId);
}

// First run: load lots from seed/items.json (+ photos in seed/photos) if present, else placeholders.
if (db.prepare('SELECT COUNT(*) AS n FROM items').get().n === 0) {
  const ins = db.prepare(`INSERT INTO items (lot_no, title, description, donor, value_note, start_bid, increment, mode, logo, link)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const seedDir = path.join(__dirname, '..', 'seed');
  const seedFile = path.join(seedDir, 'items.json');
  const copy = (sub, f) => {
    if (!f || !fs.existsSync(path.join(seedDir, sub, f))) return null;
    fs.copyFileSync(path.join(seedDir, sub, f), path.join(UPLOAD_DIR, f));
    return f;
  };
  if (fs.existsSync(seedFile)) {
    for (const it of JSON.parse(fs.readFileSync(seedFile, 'utf8'))) {
      const id = Number(ins.run(it.lot_no, it.title, it.description || '', it.donor || '', it.value_note || '', it.start_bid, it.increment,
        it.mode === 'live' ? 'live' : 'online', copy('logos', it.logo), it.link || null).lastInsertRowid);
      const photos = it.images || (it.image ? [it.image] : []);
      photos.forEach((f, i) => { if (copy('photos', f)) db.prepare('INSERT INTO item_photos (item_id, file, sort) VALUES (?, ?, ?)').run(id, f, i); });
      syncCover(id);
    }
  } else {
    const samples = [
      [1, 'Weekend getaway for two (placeholder)', 'Replace with the real lot details.', 'Donor name', 'Valued at R6 000', 1000, 500, 'live'],
      [2, 'Signed rugby jersey (placeholder)', 'Replace with the real lot details.', 'Donor name', 'Valued at R3 500', 500, 250, 'live'],
      [3, 'Restaurant voucher (placeholder)', 'Replace with the real lot details.', 'Donor name', 'Valued at R2 000', 250, 50, 'online'],
      [4, 'Local artwork (placeholder)', 'Replace with the real lot details.', 'Donor name', 'Valued at R4 000', 800, 250, 'online'],
      [5, 'Wine case (placeholder)', 'Replace with the real lot details.', 'Donor name', 'Valued at R1 800', 250, 50, 'online']
    ];
    for (const s of samples) ins.run(...s, null, null);
  }
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, tx, getSettings, setSetting, syncCover, DATA_DIR, UPLOAD_DIR };
