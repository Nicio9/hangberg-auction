'use strict';
const { db, tx, getSettings } = require('./db');

/**
 * Proxy ("automatic") bidding.
 *
 * Each bidder submits the MAXIMUM they are willing to pay. Their visible bid is only
 * as high as it needs to be: one increment above the next-best maximum, never above
 * their own maximum. Ties go to whoever set that maximum first.
 *
 * The visible state is re-derived by replaying every max bid in order, so removing
 * a bid in the admin area gives a correct result automatically.
 */
function replay(item, maxBids) {
  const inc = item.increment;
  let leader = null, leaderMax = 0, price = null;
  const history = []; // visible bids: {user_id, amount, auto, at}

  for (const b of maxBids) {
    if (leader === null) {
      leader = b.user_id; leaderMax = b.max_amount; price = item.start_bid;
      history.push({ user_id: b.user_id, amount: price, auto: false, at: b.created_at });
    } else if (b.user_id === leader) {
      if (b.max_amount > leaderMax) leaderMax = b.max_amount; // raising own ceiling, price unchanged
    } else if (b.max_amount > leaderMax) {
      // New bidder beats the current maximum.
      if (leaderMax > price) history.push({ user_id: leader, amount: leaderMax, auto: true, at: b.created_at });
      price = Math.min(b.max_amount, leaderMax + inc);
      leader = b.user_id; leaderMax = b.max_amount;
      history.push({ user_id: b.user_id, amount: price, auto: false, at: b.created_at });
    } else if (b.max_amount > price) {
      // New bid is below (or equal to) the leader's maximum: system bids for the leader.
      history.push({ user_id: b.user_id, amount: b.max_amount, auto: false, at: b.created_at });
      price = Math.min(leaderMax, b.max_amount + inc);
      history.push({ user_id: leader, amount: price, auto: true, at: b.created_at });
    }
  }
  return { price, leader, leaderMax: leader === null ? null : leaderMax, history, count: history.length };
}

function loadMaxBids(itemId) {
  return db.prepare('SELECT * FROM max_bids WHERE item_id = ? ORDER BY id').all(itemId);
}

function recompute(itemId) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  const r = replay(item, loadMaxBids(itemId));
  db.prepare('UPDATE items SET current_price = ?, leader_id = ?, leader_max = ?, bid_count = ? WHERE id = ?')
    .run(r.price, r.leader, r.leaderMax, r.count, itemId);
  return r;
}

function history(itemId) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  return replay(item, loadMaxBids(itemId)).history.reverse();
}

function closeTime(item, settings = getSettings()) {
  return new Date(item.closes_at || (item.mode === 'live' ? settings.live_closes_at : settings.online_closes_at));
}

/**
 * Final outcome of a lot.
 * Online-only lots: the highest online bid wins once bidding closes.
 * Online-to-live lots: the online leader's current bid is the opening bid at the dinner, and their
 * maximum stays in play. If the room's highest bid does not beat the online maximum, the online
 * bidder wins at one increment above the room's highest bid (capped at their maximum), the same
 * rule as online bidding. If nobody in the room bids, they win at the opening bid.
 * Returns { state, winner: 'online'|'room'|null, userId, price }.
 * state: 'open' | 'upcoming' | 'awaiting_live' | 'final'
 */
function result(item, settings = getSettings()) {
  const st = status(item, settings);
  if (st !== 'closed') return { state: st, winner: null, userId: null, price: null };
  if (item.mode === 'live' && !item.live_done) return { state: 'awaiting_live', winner: null, userId: null, price: null };
  if (item.mode === 'live') return liveOutcome(item, item.room_bid);
  if (item.leader_id == null) return { state: 'final', winner: null, userId: null, price: null };
  return { state: 'final', winner: 'online', userId: item.leader_id, price: item.current_price };
}

function liveOutcome(item, roomBid) {
  const room = roomBid == null || roomBid === '' ? null : Number(roomBid);
  const hasOnline = item.leader_id != null;
  if (room == null) {
    return hasOnline ? { state: 'final', winner: 'online', userId: item.leader_id, price: item.current_price }
                     : { state: 'final', winner: null, userId: null, price: null };
  }
  if (hasOnline && room <= item.leader_max) {
    const price = room === item.leader_max ? item.leader_max : Math.min(item.leader_max, room + item.increment);
    return { state: 'final', winner: 'online', userId: item.leader_id, price: Math.max(price, item.current_price) };
  }
  return { state: 'final', winner: 'room', userId: null, price: room };
}

function status(item, settings = getSettings(), now = new Date()) {
  if (now < new Date(settings.opens_at)) return 'upcoming';
  if (now >= closeTime(item, settings)) return 'closed';
  return 'open';
}

function minimumBid(item, userId) {
  if (item.leader_id == null) return item.start_bid;
  if (userId && item.leader_id === userId) return item.leader_max + item.increment;
  return item.current_price + item.increment;
}

/**
 * Place a maximum bid. Returns { ok, message, outbidUserId, item }.
 * Runs inside an immediate transaction so simultaneous bids are processed one at a time.
 */
function placeBid(itemId, userId, amount) {
  return tx(() => {
    const settings = getSettings();
    const item = db.prepare('SELECT * FROM items WHERE id = ? AND visible = 1').get(itemId);
    if (!item) return { ok: false, message: 'That lot could not be found.' };
    const st = status(item, settings);
    if (st === 'upcoming') return { ok: false, message: 'Bidding has not opened yet.' };
    if (st === 'closed') return { ok: false, message: 'Bidding on this lot has closed.' };

    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, message: 'Please enter a whole rand amount.' };
    if (amount > 10_000_000) return { ok: false, message: 'That amount looks too high — please check it.' };
    const min = minimumBid(item, userId);
    if (amount < min) {
      const why = item.leader_id === userId
        ? `You are already the highest bidder with a maximum of R${fmt(item.leader_max)}. To raise your maximum, enter at least R${fmt(min)}.`
        : `Your bid must be at least R${fmt(min)}.`;
      return { ok: false, message: why };
    }

    const prevLeader = item.leader_id;
    db.prepare('INSERT INTO max_bids (item_id, user_id, max_amount) VALUES (?, ?, ?)').run(itemId, userId, amount);
    const r = recompute(itemId);

    // Optional anti-sniping: a bid in the last N minutes extends that lot's closing time.
    const ext = parseInt(settings.extend_minutes, 10) || 0;
    if (ext > 0) {
      const close = closeTime(item, settings);
      const cutoff = new Date(close.getTime() - ext * 60000);
      if (new Date() >= cutoff) {
        db.prepare('UPDATE items SET closes_at = ? WHERE id = ?').run(new Date(Date.now() + ext * 60000).toISOString(), itemId);
      }
    }

    const fresh = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
    let message;
    let leading = r.leader === userId;
    if (prevLeader === userId) message = `Your maximum bid is now R${fmt(amount)}. You are still the highest bidder at R${fmt(r.price)}.`;
    else if (leading) message = `You are the highest bidder at R${fmt(r.price)}. The system will bid for you up to your maximum of R${fmt(amount)}.`;
    else message = `Another bidder's maximum is higher, so you have been outbid automatically. The current bid is R${fmt(r.price)} — try a higher maximum.`;

    const outbidUserId = prevLeader && prevLeader !== userId && r.leader !== prevLeader ? prevLeader : null;
    return { ok: true, leading, message, outbidUserId, item: fresh };
  });
}

function removeMaxBid(bidId) {
  return tx(() => {
    const b = db.prepare('SELECT * FROM max_bids WHERE id = ?').get(bidId);
    if (!b) return null;
    db.prepare('DELETE FROM max_bids WHERE id = ?').run(bidId);
    recompute(b.item_id);
    return b.item_id;
  });
}

function fmt(n) {
  return Number(n).toLocaleString('en-ZA').replace(/,/g, ' ');
}

module.exports = { result, liveOutcome, replay, recompute, history, placeBid, removeMaxBid, status, closeTime, minimumBid, fmt };
