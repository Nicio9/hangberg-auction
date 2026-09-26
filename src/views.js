'use strict';
const { fmt, status, closeTime, minimumBid, result } = require('./auction');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const R = n => (n == null ? '—' : 'R' + fmt(n));
const TZ = 'Africa/Johannesburg';
const when = iso => new Intl.DateTimeFormat('en-ZA', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
// For <input type="datetime-local"> in SAST (UTC+2, no daylight saving)
const toLocalInput = iso => iso ? new Date(new Date(iso).getTime() + 2 * 3600e3).toISOString().slice(0, 16) : '';
const bidderLabel = (uid, me) => (me && uid === me.id ? 'You' : `Bidder ${1000 + uid}`);

function layout(ctx, title, body, opts = {}) {
  const { user, settings, csrf, flash } = ctx;
  const nav = user
    ? `<a href="/my-bids">My bids</a>${user.is_admin ? '<a href="/admin">Admin</a>' : ''}
       <form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="linkbtn">Log out</button></form>`
    : `<a href="/login">Log in</a><a class="btn small" href="/register">Register to bid</a>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title ? `${title} · ` : '')}${esc(settings.event_name)} Auction</title>
<link rel="stylesheet" href="/static/style.css">
</head><body${opts.bodyAttrs || ''}>
<header class="top"><div class="wrap bar">
  <a class="brand" href="/"><span class="mark" aria-hidden="true">HET</span><span><strong>Online Auction</strong><small>${esc(settings.event_name)}</small></span></a>
  <nav>${nav}<a href="/how-it-works">How it works</a></nav>
</div></header>
<main class="wrap">
${flash ? `<div class="flash ${esc(flash.type || 'info')}" role="status">${esc(flash.msg)}</div>` : ''}
${body}
</main>
<footer class="wrap foot">
  <p>${esc(settings.event_name)} · ${esc(settings.event_date)}${settings.contact_email ? ` · Questions? <a href="mailto:${esc(settings.contact_email)}">${esc(settings.contact_email)}</a>` : ''}</p>
  <p class="muted">All times are South African time (SAST).</p>
</footer>
<script src="/static/app.js" defer></script>
</body></html>`;
}

function auctionBanner(settings) {
  const now = new Date();
  const opens = new Date(settings.opens_at), liveC = new Date(settings.live_closes_at), onlineC = new Date(settings.online_closes_at);
  if (now < opens) return `<div class="banner">Online bidding opens <strong>${when(opens)}</strong> <span class="count" data-until="${opens.toISOString()}"></span></div>`;
  if (now < onlineC) return `<div class="banner live">Online bidding is open.
    ${now < liveC ? `<br><strong>Online-to-live lots</strong> close online <strong>${when(liveC)}</strong> <span class="count" data-until="${liveC.toISOString()}"></span>` : '<br>Online-to-live lots have closed online and go under the hammer at the dinner.'}
    <br><strong>Online-only lots</strong> close <strong>${when(onlineC)}</strong> <span class="count" data-until="${onlineC.toISOString()}"></span></div>`;
  return `<div class="banner closed">Bidding has closed. Thank you for supporting the Hangberg Educational Trust!</div>`;
}

const modeTag = it => it.mode === 'live' ? '<span class="pill live">Online-to-live</span>' : '<span class="pill">Online only</span>';

function img(item, cls = '') {
  return item.image
    ? `<img class="${cls}" src="/uploads/${esc(item.image)}" alt="${esc(item.title)}" loading="lazy">`
    : `<div class="${cls} noimg" aria-hidden="true">Lot ${item.lot_no}</div>`;
}

function statePill(item, user, settings) {
  if (!user) return '';
  const r = result(item, settings);
  if (r.state === 'final') return r.userId === user.id ? '<span class="pill win">You won</span>' : '';
  if (item.leader_id === user.id) return r.state === 'awaiting_live' ? '<span class="pill win">Leading into live auction</span>' : '<span class="pill win">You are winning</span>';
  if (item.i_bid) return '<span class="pill out">Outbid</span>';
  return '';
}

function cardFooter(it, settings) {
  const r = result(it, settings);
  if (r.state === 'awaiting_live') return '<span>Live at the dinner</span>';
  if (r.state === 'final') return `<span>${r.winner ? 'Sold' : 'Closed'}</span>`;
  return `<span class="count" data-until="${closeTime(it, settings).toISOString()}"></span>`;
}

function home(ctx, items) {
  const { settings, user } = ctx;
  const card = it => {
    const r = result(it, settings);
    const label = r.state === 'final' && r.winner ? 'Sold for' : r.state === 'awaiting_live' ? 'Live opening bid' : it.bid_count ? 'Current bid' : 'Opening bid';
    const price = r.state === 'final' && r.winner ? r.price : (it.current_price ?? it.start_bid);
    return `<a class="card" href="/lot/${it.id}" data-item="${it.id}">
      <div class="thumbwrap">${img(it, 'thumb')}${it.logo ? `<img class="cardlogo" src="/uploads/${esc(it.logo)}" alt="" loading="lazy">` : ''}</div>
      <div class="card-body">
        <div class="lot">Lot ${it.lot_no} ${statePill(it, user, settings)}</div>
        <h3>${esc(it.title)}</h3>
        <div class="row"><span class="muted">${label}</span><strong class="price" data-price>${R(price)}</strong></div>
        <div class="row small muted"><span>Min. bid increment</span><strong class="inc">${R(it.increment)}</strong></div>
        <div class="row small muted"><span data-bids>${it.bid_count} bid${it.bid_count === 1 ? '' : 's'}</span>${cardFooter(it, settings)}</div>
      </div></a>`;
  };
  const live = items.filter(i => i.mode === 'live'), online = items.filter(i => i.mode !== 'live');
  return layout(ctx, '', `
  <section class="hero">
    <h1>${esc(settings.event_name)}</h1>
    <p>${esc(settings.intro)}</p>
    ${auctionBanner(settings)}
    ${user ? '' : '<p><a class="btn" href="/register">Register to bid</a> <a class="btn ghost" href="/how-it-works">How bidding works</a></p>'}
  </section>
  <div data-poll>
  ${live.length ? `<section class="group"><h2>Online-to-live lots</h2>
    <p class="muted">Bid online until ${when(settings.live_closes_at)}. The highest online bid becomes the opening bid at the live auction on ${esc(settings.event_date)}, and your online maximum stays in play on the night.</p>
    <div class="grid">${live.map(card).join('')}</div></section>` : ''}
  ${online.length ? `<section class="group"><h2>Online-only lots</h2>
    <p class="muted">Bid online until ${when(settings.online_closes_at)}. The highest online bid wins. These items are on display at the dinner.</p>
    <div class="grid">${online.map(card).join('')}</div></section>` : ''}
  ${items.length ? '' : '<p class="muted">No lots have been added yet.</p>'}
  </div>`);
}

function lot(ctx, item, hist, photos = []) {
  const { settings, user, csrf } = ctx;
  const st = status(item, settings);
  const min = minimumBid(item, user && user.id);
  const iLead = user && item.leader_id === user.id;
  let bidBox;
  if (st === 'upcoming') bidBox = `<p class="muted">Bidding opens ${when(settings.opens_at)}.</p>`;
  else if (st === 'closed') {
    const r = result(item, settings);
    if (r.state === 'awaiting_live') bidBox = `<div class="notice"><strong>Online bidding has closed.</strong> This lot goes to the live auction at the dinner on ${esc(settings.event_date)}${item.leader_id ? `, with an opening bid of <strong>${R(item.current_price)}</strong>` : ''}.
      ${iLead ? `<br>You are the top online bidder. Your maximum of ${R(item.leader_max)} stays in play: if the room does not go above it, you win at one increment above the room's highest bid.` : ''}</div>`;
    else if (r.winner) bidBox = `<p><strong>Sold for ${R(r.price)}</strong>${r.userId && user && r.userId === user.id ? ' — congratulations, you won this lot! We will be in touch about payment and collection.' : '.'}</p>`;
    else bidBox = '<p>This lot closed without bids.</p>';
  }
  else if (!user) bidBox = `<p><a class="btn" href="/login?next=/lot/${item.id}">Log in to bid</a> or <a href="/register">register</a>.</p>`;
  else bidBox = `
    ${iLead ? `<p class="pill win big">You are the highest bidder · your maximum is ${R(item.leader_max)}</p>` : ''}
    <form method="post" action="/lot/${item.id}/bid" class="bidform" data-confirm>
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <label for="amount">${iLead ? 'Raise your maximum bid' : 'Your maximum bid'} (R)</label>
      <div class="bidrow">
        <input id="amount" name="amount" type="number" inputmode="numeric" min="${min}" step="1" value="${min}" required>
        <button class="btn">Place bid</button>
      </div>
      <p class="small muted">Enter the most you are willing to pay (at least ${R(min)}). The system bids for you, one increment of ${R(item.increment)} at a time, only as far as needed.</p>
    </form>`;

  const rows = hist.map(h => `<tr${user && h.user_id === user.id ? ' class="me"' : ''}><td>${esc(bidderLabel(h.user_id, user))}</td><td>${R(h.amount)}${h.auto ? ' <span class="muted small">(auto)</span>' : ''}</td><td class="muted small">${when(h.at)}</td></tr>`).join('');

  return layout(ctx, item.title, `
  <p><a href="/">← All lots</a></p>
  <article class="detail" data-poll data-item="${item.id}">
    <div class="media">${photos.length ? `<img class="big" data-main src="/uploads/${esc(photos[0].file)}" alt="${esc(item.title)}">
      ${photos.length > 1 ? `<div class="thumbs">${photos.map((ph, i) => `<button type="button" class="thumbbtn${i ? '' : ' on'}" data-src="/uploads/${esc(ph.file)}" aria-label="Photo ${i + 1}"><img src="/uploads/${esc(ph.file)}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}` : img(item, 'big')}</div>
    <div class="info">
      <div class="lot">Lot ${item.lot_no} ${modeTag(item)}</div>
      <h1>${esc(item.title)}</h1>
      ${item.donor || item.logo ? `<div class="donor">${item.logo ? `<img class="logo${/qr/i.test(item.logo) ? ' qr' : ''}" src="/uploads/${esc(item.logo)}" alt="${esc(item.donor || 'Donor logo')}">` : ''}${item.donor ? `<span class="muted">Donated by ${esc(item.donor)}</span>` : ''}</div>` : ''}
      <div class="pricebox">
        <div><span class="muted">${item.bid_count ? 'Current bid' : 'Minimum opening bid'}</span><strong class="price" data-price>${R(item.current_price ?? item.start_bid)}</strong></div>
        <div><span class="muted">Minimum bid increment</span><strong>${R(item.increment)}</strong></div>
        <div><span class="muted">${st === 'closed' ? 'Online bidding closed' : 'Online bidding closes'}</span><strong>${when(closeTime(item, settings))}</strong>${st === 'open' ? `<span class="count small" data-until="${closeTime(item, settings).toISOString()}"></span>` : ''}</div>
      </div>
      ${item.mode === 'live' && st !== 'closed' ? `<p class="small notice">Online-to-live lot: online bidding closes ${when(closeTime(item, settings))}. The highest online bid becomes the opening bid at the live auction on ${esc(settings.event_date)}, and the top online bidder's maximum stays in play.</p>` : ''}
      ${bidBox}
      ${item.value_note ? `<p><strong>${esc(item.value_note)}</strong></p>` : ''}
      <div class="desc">${esc(item.description).replace(/\n/g, '<br>')}</div>
      ${item.link ? `<p class="morelink"><a class="btn ghost small" href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">More information about ${esc(item.donor || 'this lot')} ↗</a></p>` : ''}
    </div>
  </article>
  <section><h2>Bid history</h2>
    ${rows ? `<table class="table"><thead><tr><th>Bidder</th><th>Bid</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No bids yet — be the first!</p>'}
  </section>`);
}

function form(ctx, title, inner, action, extra = '') {
  return layout(ctx, title, `<section class="panel narrow"><h1>${esc(title)}</h1>${extra}
  <form method="post" action="${action}" class="stack"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">${inner}</form></section>`);
}
const field = (name, label, type = 'text', value = '', attrs = '') =>
  `<label>${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`;

function register(ctx, v = {}) {
  return form(ctx, 'Register to bid', `
    <div class="two">${field('first_name', 'First name', 'text', v.first_name, 'required autocomplete="given-name"')}
    ${field('last_name', 'Surname', 'text', v.last_name, 'required autocomplete="family-name"')}</div>
    ${field('email', 'Email address', 'email', v.email, 'required autocomplete="email"')}
    ${field('phone', 'Cellphone number', 'tel', v.phone, 'required autocomplete="tel"')}
    ${field('password', 'Create a password (at least 8 characters)', 'password', '', 'required minlength="8" autocomplete="new-password"')}
    ${field('password2', 'Confirm password', 'password', '', 'required minlength="8" autocomplete="new-password"')}
    <label class="check"><input type="checkbox" name="terms" value="1" required> I have read <a href="/how-it-works" target="_blank">how bidding works</a> and agree that my bids are binding.</label>
    <button class="btn">Create account</button>
    <p class="small muted">We'll email you a link to confirm your address before you can bid.</p>`,
    '/register', '<p>Already registered? <a href="/login">Log in</a></p>');
}

function login(ctx, next = '', email = '') {
  return form(ctx, 'Log in', `
    <input type="hidden" name="next" value="${esc(next)}">
    ${field('email', 'Email address', 'email', email, 'required autocomplete="email"')}
    ${field('password', 'Password', 'password', '', 'required autocomplete="current-password"')}
    <button class="btn">Log in</button>
    <p class="small"><a href="/forgot">Forgot your password?</a> · <a href="/resend">Resend confirmation email</a></p>`,
    '/login', '<p>New here? <a href="/register">Register to bid</a></p>');
}

function message(ctx, title, text, link) {
  return layout(ctx, title, `<section class="panel narrow"><h1>${esc(title)}</h1><p>${esc(text)}</p>${link ? `<p><a class="btn" href="${link.href}">${esc(link.label)}</a></p>` : ''}</section>`);
}

function emailOnly(ctx, title, action, intro) {
  return form(ctx, title, `<p>${esc(intro)}</p>${field('email', 'Email address', 'email', '', 'required')}<button class="btn">Send link</button>`, action);
}

function reset(ctx, token) {
  return form(ctx, 'Choose a new password', `
    <input type="hidden" name="token" value="${esc(token)}">
    ${field('password', 'New password (at least 8 characters)', 'password', '', 'required minlength="8" autocomplete="new-password"')}
    ${field('password2', 'Confirm password', 'password', '', 'required minlength="8" autocomplete="new-password"')}
    <button class="btn">Save password</button>`, '/reset');
}

function myBids(ctx, items) {
  const { settings, user } = ctx;
  const rows = items.map(it => {
    const r = result(it, settings);
    const lead = it.leader_id === user.id;
    const state = r.state === 'final' ? (r.userId === user.id ? `<span class="pill win">Won at ${R(r.price)}</span>` : '<span class="pill">Not won</span>')
      : r.state === 'awaiting_live' ? (lead ? '<span class="pill win">Leading into live auction</span>' : '<span class="pill">Closed online</span>')
      : (lead ? '<span class="pill win">Winning</span>' : '<span class="pill out">Outbid</span>');
    return `<tr><td><a href="/lot/${it.id}">Lot ${it.lot_no}: ${esc(it.title)}</a></td><td>${R(it.current_price)}</td><td>${R(it.my_max)}</td><td>${state}</td></tr>`;
  }).join('');
  return layout(ctx, 'My bids', `<h1>My bids</h1>
  ${rows ? `<div class="scroll"><table class="table"><thead><tr><th>Lot</th><th>Current bid</th><th>Your maximum</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">You have not placed any bids yet. <a href="/">Browse the lots</a>.</p>'}`);
}

function howItWorks(ctx) {
  const s = ctx.settings;
  return layout(ctx, 'How it works', `<section class="panel prose">
  <h1>How bidding works</h1>
  <h2>Who can bid online?</h2>
  <p>To bid online, register with your name, email address and cellphone number, and create a password as a security measure. We'll email you a confirmation link. Once you've clicked it, you can start bidding.</p>
  <h2>Two kinds of lots</h2>
  <p><strong>Online-to-live lots.</strong> A handful of lots will be closed live at the dinner on ${esc(s.event_date)}. Online bidding on these closes <strong>${when(s.live_closes_at)}</strong>. The highest online bid becomes the opening bid at the live auction. The top online bidder's maximum stays in play on the night: if the room does not go above it, the online bidder wins, at one increment above the room's highest bid (the same way online bidding works). If nobody in the room bids, the online bidder wins at the opening bid.</p>
  <p><strong>Online-only lots.</strong> Bidding closes <strong>${when(s.online_closes_at)}</strong>. The highest online bid wins. All physical items will be on display at the dinner.</p>
  <h2>Placing a bid</h2>
  <p>To place a bid, you need to bid higher than the current bid by at least the minimum bid increment (R500, R250 or R50, depending on the value of the item; shown on each lot).</p>
  <p>When you place your bid, <strong>you are stipulating the highest amount you are willing to bid</strong>. Your actual bid is simply one bid increment up from the current bid, and <strong>the system will automatically bid on your behalf</strong>, by the bid increment, as other people bid on the item, <strong>until your maximum is reached</strong>.</p>
  <div class="example"><strong>Example:</strong> The current bid is R250 and the increment is R50. You bid R1 000 — you are actually only bidding R300. If someone else then bids R650, the system automatically bids R700 on your behalf, as that is under your maximum of R1 000. You will receive an email if someone outbids your maximum bid.</div>
  <p>If two bidders enter the same maximum, the bidder who entered it first stays in the lead.${parseInt(s.extend_minutes, 10) > 0 ? ` A bid placed in the last ${esc(s.extend_minutes)} minutes before a lot closes online extends that lot by ${esc(s.extend_minutes)} minutes.` : ''}</p>
  <h2>Winning</h2>
  <p>Bids are binding. ${esc(s.payment_info)}</p>
  <p class="muted small">Online bidding opens ${when(s.opens_at)}. All times are South African time (SAST).</p>
  </section>`);
}

/* ---------------- Admin ---------------- */

function adminNav(active) {
  const l = (h, t) => `<a href="${h}" class="${active === h ? 'on' : ''}">${t}</a>`;
  return `<nav class="subnav">${l('/admin', 'Overview')}${l('/admin/items', 'Lots')}${l('/admin/bidders', 'Bidders')}${l('/admin/live', 'Live auction')}${l('/admin/results', 'Results')}${l('/admin/settings', 'Settings')}</nav>`;
}

function adminHome(ctx, stats) {
  return layout(ctx, 'Admin', `<h1>Admin</h1>${adminNav('/admin')}${auctionBanner(ctx.settings)}
  <div class="stats">
    <div><span>Total of current bids</span><strong>${R(stats.total)}</strong></div>
    <div><span>Lots</span><strong>${stats.items}</strong></div>
    <div><span>Lots with bids</span><strong>${stats.withBids}</strong></div>
    <div><span>Registered bidders</span><strong>${stats.users}</strong></div>
    <div><span>Confirmed</span><strong>${stats.confirmed}</strong></div>
    <div><span>Bids placed</span><strong>${stats.bids}</strong></div>
  </div>`);
}

function adminItems(ctx, items) {
  const rows = items.map(it => `<tr${it.visible ? '' : ' class="dim"'}>
    <td>${it.lot_no}</td><td><a href="/admin/items/${it.id}">${esc(it.title)}</a>${it.visible ? '' : ' <span class="pill">hidden</span>'}</td><td>${it.mode === 'live' ? 'Online-to-live' : 'Online only'}</td>
    <td>${R(it.start_bid)}</td><td>${R(it.increment)}</td><td>${R(it.current_price)}</td><td>${it.bid_count}</td>
    <td>${it.leader_name ? esc(it.leader_name) : '—'}</td></tr>`).join('');
  return layout(ctx, 'Lots', `<h1>Lots</h1>${adminNav('/admin/items')}
  <p><a class="btn" href="/admin/items/new">Add a lot</a></p>
  <div class="scroll"><table class="table"><thead><tr><th>#</th><th>Title</th><th>Type</th><th>Start</th><th>Increment</th><th>Current</th><th>Bids</th><th>Leading bidder</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

function adminItem(ctx, it, bids, photos = []) {
  const isNew = !it.id;
  const incs = [50, 100, 250, 500, 1000].map(v => `<option value="${v}"></option>`).join('');
  const bidRows = (bids || []).map(b => `<tr><td>${esc(b.first_name)} ${esc(b.last_name)}<br><span class="small muted">${esc(b.email)} · ${esc(b.phone)}</span></td><td>${R(b.max_amount)}</td><td class="small">${when(b.created_at)}</td>
    <td><form method="post" action="/admin/bids/${b.id}/delete" data-confirm="Remove this bid? The lot's current bid will be recalculated."><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><button class="linkbtn danger">Remove</button></form></td></tr>`).join('');
  return layout(ctx, isNew ? 'Add lot' : `Edit lot ${it.lot_no}`, `<h1>${isNew ? 'Add a lot' : `Edit lot ${it.lot_no}`}</h1>${adminNav('/admin/items')}
  <form method="post" action="/admin/items/${isNew ? 'new' : it.id}" enctype="multipart/form-data" class="panel stack">
    <input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">
    <div class="two">${field('lot_no', 'Lot number', 'number', it.lot_no, 'required min="1"')}
    ${field('title', 'Title', 'text', it.title, 'required')}</div>
    <label>Description<textarea name="description" rows="6">${esc(it.description)}</textarea></label>
    ${field('link', 'Donor website or Instagram link (optional)', 'url', it.link || '')}
    <div class="two">${field('donor', 'Donated by', 'text', it.donor)}${field('value_note', 'Value note (e.g. "Valued at R5 000")', 'text', it.value_note)}</div>
    <label>Lot type<select name="mode"><option value="online"${it.mode !== 'live' ? ' selected' : ''}>Online only (closes ${when(ctx.settings.online_closes_at)})</option><option value="live"${it.mode === 'live' ? ' selected' : ''}>Online-to-live (online closes ${when(ctx.settings.live_closes_at)}, then live at the dinner)</option></select></label>
    <div class="two">${field('start_bid', 'Minimum opening bid (R)', 'number', it.start_bid, 'required min="1"')}
    <label>Bid increment (R)<input name="increment" type="number" min="1" step="1" list="incs" value="${esc(it.increment)}" required><datalist id="incs">${incs}</datalist></label></div>
    ${field('closes_at', 'Special online closing time for this lot only (SAST). Leave blank to use the normal time for its type', 'datetime-local', toLocalInput(it.closes_at))}
    <label>Add photos (you can choose several at once; the first photo is shown on the lot card)<input type="file" name="photos" multiple accept="image/jpeg,image/png,image/webp"></label>
    <label>Donor / sponsor logo ${it.logo ? `<img src="/uploads/${esc(it.logo)}" class="preview logo" alt="">` : ''}<input type="file" name="logo" accept="image/png,image/jpeg,image/webp"></label>
    <label class="check"><input type="checkbox" name="visible" value="1"${it.visible !== 0 ? ' checked' : ''}> Show this lot on the site</label>
    <button class="btn">Save lot</button>
  </form>
  ${isNew ? '' : `<section><h2>Photos</h2>
  ${photos.length ? `<div class="adminphotos">${photos.map((ph, i) => `<figure><img src="/uploads/${esc(ph.file)}" alt=""><figcaption>${i === 0 ? '<strong>Main photo</strong>' : `<form method="post" action="/admin/photos/${ph.id}/first" class="inline"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><button class="linkbtn">Make main</button></form>`}
    · <form method="post" action="/admin/photos/${ph.id}/delete" class="inline" data-confirm="Remove this photo?"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><button class="linkbtn danger">Remove</button></form></figcaption></figure>`).join('')}</div>` : '<p class="muted">No photos yet. Add them with the form above.</p>'}
  ${it.logo ? `<form method="post" action="/admin/items/${it.id}/remove-logo" data-confirm="Remove the logo?"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><button class="linkbtn danger">Remove logo</button></form>` : ''}
  </section>
  <section><h2>Maximum bids on this lot</h2><p class="small muted">Only you can see bidders' maximums and contact details.</p>
  ${bidRows ? `<div class="scroll"><table class="table"><thead><tr><th>Bidder</th><th>Maximum</th><th>Time</th><th></th></tr></thead><tbody>${bidRows}</tbody></table></div>` : '<p class="muted">No bids.</p>'}
  ${it.bid_count ? '' : `<form method="post" action="/admin/items/${it.id}/delete" data-confirm="Delete this lot permanently?"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><button class="btn ghost danger">Delete lot</button></form>`}</section>`}`);
}

function adminBidders(ctx, users) {
  const rows = users.map(u => `<tr${u.disabled ? ' class="dim"' : ''}><td>${1000 + u.id}</td><td>${esc(u.first_name)} ${esc(u.last_name)}${u.is_admin ? ' <span class="pill">admin</span>' : ''}</td><td>${esc(u.email)}</td><td>${esc(u.phone)}</td>
    <td>${u.confirmed ? 'Yes' : 'No'}</td><td>${u.bids}</td><td class="small">${when(u.created_at)}</td>
    <td>${u.is_admin ? '' : `<form method="post" action="/admin/bidders/${u.id}/toggle"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><button class="linkbtn">${u.disabled ? 'Enable' : 'Block'}</button></form>`}
    ${u.confirmed ? '' : `<form method="post" action="/admin/bidders/${u.id}/confirm"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><button class="linkbtn">Confirm manually</button></form>`}</td></tr>`).join('');
  return layout(ctx, 'Bidders', `<h1>Bidders</h1>${adminNav('/admin/bidders')}
  <p><a href="/admin/bidders.csv">Download as CSV</a></p>
  <div class="scroll"><table class="table"><thead><tr><th>Bidder no.</th><th>Name</th><th>Email</th><th>Cell</th><th>Confirmed</th><th>Bids</th><th>Registered</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

function adminResults(ctx, rows) {
  const s = ctx.settings;
  let total = 0, pending = 0;
  const tr = rows.map(r => {
    const o = result(r, s);
    if (o.state === 'final' && o.winner) total += o.price;
    if (o.state === 'awaiting_live') pending++;
    const winner = o.state !== 'final' ? (r.leader_id ? `<span class="muted">Leading: ${esc(r.first_name)} ${esc(r.last_name)}</span>` : '—')
      : o.winner === 'online' ? `${esc(r.first_name)} ${esc(r.last_name)} (online)<br><span class="small muted">${esc(r.email)} · ${esc(r.phone)}</span>`
      : o.winner === 'room' ? `${esc(r.room_bidder || 'Room bidder')} (at the dinner)` : 'No bids';
    const stateText = { open: 'Open', upcoming: 'Not open yet', awaiting_live: 'Awaiting live auction', final: 'Final' }[o.state];
    return `<tr><td>${r.lot_no}</td><td>${esc(r.title)}<br><span class="small muted">${r.mode === 'live' ? 'Online-to-live' : 'Online only'}</span></td>
      <td>${o.state === 'final' ? (o.winner ? R(o.price) : '—') : `<span class="muted">${R(r.current_price)}</span>`}</td>
      <td>${winner}</td><td>${stateText}</td><td>${r.winner_notified ? 'Sent' : ''}</td></tr>`;
  }).join('');
  return layout(ctx, 'Results', `<h1>Results</h1>${adminNav('/admin/results')}
  <p>Total raised on final lots: <strong>${R(total)}</strong>${pending ? ` · ${pending} lot${pending === 1 ? '' : 's'} still awaiting the live auction result (<a href="/admin/live">record them</a>)` : ''}</p>
  <p><a href="/admin/results.csv">Download results as CSV</a></p>
  <form method="post" action="/admin/notify-winners" data-confirm="Email every online winner of a final lot who hasn't been emailed yet?" class="inline">
    <input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><button class="btn">Email online winners of final lots</button></form>
  <p class="small muted">Room winners at the dinner are not emailed — settle those on the night.</p>
  <div class="scroll"><table class="table"><thead><tr><th>#</th><th>Lot</th><th>Winning bid</th><th>Winner</th><th>Status</th><th>Winner emailed</th></tr></thead><tbody>${tr}</tbody></table></div>`);
}

function liveSheet(ctx, rows) {
  const s = ctx.settings;
  const cards = rows.map(r => {
    const o = result(r, s);
    const open = status(r, s) !== 'closed';
    return `<article class="panel livelot" id="lot-${r.id}">
      <h2>Lot ${r.lot_no}: ${esc(r.title)}</h2>
      <div class="pricebox">
        <div><span class="muted">Opening bid</span><strong class="price">${r.leader_id ? R(r.current_price) : R(r.start_bid) + ' (no online bids)'}</strong></div>
        <div><span class="muted">Increment</span><strong>${R(r.increment)}</strong></div>
        <div><span class="muted">Top online bidder</span><strong>${r.leader_id ? `${esc(r.first_name)} ${esc(r.last_name)} · Bidder ${1000 + r.leader_id}` : '—'}</strong></div>
        <div><span class="muted">Online maximum (confidential)</span><strong>${r.leader_id ? R(r.leader_max) : '—'}</strong></div>
      </div>
      ${r.leader_id ? `<p class="small">The auctioneer bids for the online bidder up to ${R(r.leader_max)}. If the room's highest bid is ${R(r.leader_max)} or less, the online bidder wins at one increment above it.</p>` : ''}
      ${open ? '<p class="notice small">Online bidding on this lot is still open — figures may change.</p>' : ''}
      <form method="post" action="/admin/live/${r.id}" class="stack noprint">
        <input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">
        <div class="two">${field('room_bid', "Highest bid from the room (R) — leave blank if nobody in the room bid", 'number', r.room_bid ?? '', 'min="0" step="1"')}
        ${field('room_bidder', 'Room bidder (name, table or paddle no., cell)', 'text', r.room_bidder || '')}</div>
        <button class="btn">${r.live_done ? 'Update result' : 'Record live result'}</button>
      </form>
      ${r.live_done ? `<p class="flash success">Result: ${o.winner === 'online' ? `online bidder ${esc(r.first_name)} ${esc(r.last_name)} wins at ${R(o.price)}` : o.winner === 'room' ? `${esc(r.room_bidder || 'room bidder')} wins at ${R(o.price)}` : 'not sold'}</p>` : ''}
    </article>`;
  }).join('');
  return layout(ctx, 'Live auction', `<h1>Live auction sheet</h1>${adminNav('/admin/live')}
  <p class="noprint">Print this page for the auctioneer (the online maximums are confidential). On the night, enter the room's highest bid for each lot and the site works out the winner. <button class="linkbtn" data-print>Print</button></p>
  ${cards || '<p class="muted">No online-to-live lots yet. Set a lot\'s type to "Online-to-live" in Lots.</p>'}`);
}

function adminSettings(ctx) {
  const s = ctx.settings;
  return layout(ctx, 'Settings', `<h1>Settings</h1>${adminNav('/admin/settings')}
  <form method="post" action="/admin/settings" class="panel stack">
    <input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">
    ${field('event_name', 'Event name', 'text', s.event_name, 'required')}
    ${field('event_date', 'Event date (display text)', 'text', s.event_date)}
    ${field('opens_at', 'Online bidding opens (SAST)', 'datetime-local', toLocalInput(s.opens_at), 'required')}
    <div class="two">${field('live_closes_at', 'Online-to-live lots close online (SAST)', 'datetime-local', toLocalInput(s.live_closes_at), 'required')}
    ${field('online_closes_at', 'Online-only lots close (SAST)', 'datetime-local', toLocalInput(s.online_closes_at), 'required')}</div>
    ${field('extend_minutes', 'Anti-sniping: extend a lot by this many minutes when bid on near closing (0 = off)', 'number', s.extend_minutes, 'min="0" max="30"')}
    <label>Welcome text<textarea name="intro" rows="3">${esc(s.intro)}</textarea></label>
    <label>Payment &amp; collection info (shown to bidders and in winner emails)<textarea name="payment_info" rows="3">${esc(s.payment_info)}</textarea></label>
    ${field('contact_email', 'Contact email shown in footer', 'email', s.contact_email)}
    <button class="btn">Save settings</button>
  </form>`);
}

module.exports = { layout, home, lot, register, login, message, emailOnly, reset, myBids, howItWorks, adminHome, adminItems, adminItem, adminBidders, adminResults, adminSettings, liveSheet, R, when };
