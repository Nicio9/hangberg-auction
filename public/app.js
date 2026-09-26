'use strict';
(function () {
  // Countdown timers
  function tick() {
    const now = Date.now();
    document.querySelectorAll('[data-until]').forEach(el => {
      const ms = new Date(el.dataset.until).getTime() - now;
      if (ms <= 0) { el.textContent = ''; return; }
      const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1e3) % 60;
      el.textContent = d > 0 ? `${d}d ${h}h ${m}m left` : h > 0 ? `${h}h ${m}m left` : `${m}m ${String(s).padStart(2, '0')}s left`;
      el.classList.toggle('soon', ms < 15 * 60e3);
    });
  }
  tick(); setInterval(tick, 1000);

  // Confirm before bidding / destructive admin actions
  document.querySelectorAll('form[data-confirm]').forEach(f => f.addEventListener('submit', e => {
    let msg = f.dataset.confirm;
    if (!msg) {
      const amt = f.querySelector('[name=amount]');
      msg = `Place a maximum bid of R${Number(amt.value).toLocaleString('en-ZA')}? Bids are binding.`;
    }
    if (!window.confirm(msg)) e.preventDefault();
  }));

  document.querySelectorAll('[data-print]').forEach(b => b.addEventListener('click', () => window.print()));

  // Photo gallery on lot pages
  const main = document.querySelector('[data-main]');
  document.querySelectorAll('.thumbbtn').forEach(b => b.addEventListener('click', () => {
    if (main) main.src = b.dataset.src;
    document.querySelectorAll('.thumbbtn').forEach(x => x.classList.toggle('on', x === b));
  }));

  // Live refresh of prices every 15 seconds
  const pollRoot = document.querySelector('[data-poll]');
  if (!pollRoot) return;
  let lastBids = null;
  async function poll() {
    if (document.hidden) return;
    try {
      const res = await fetch('/api/state', { credentials: 'same-origin' });
      if (!res.ok) return;
      const items = await res.json();
      const detailId = pollRoot.dataset.item;
      for (const it of items) {
        if (detailId && String(it.id) === detailId) {
          if (lastBids !== null && it.bids !== lastBids) {
            const note = document.getElementById('newbid') || Object.assign(document.createElement('div'), { id: 'newbid', className: 'flash info' });
            note.innerHTML = 'There is a new bid on this lot. <a href="">Refresh the page</a> to see it.';
            pollRoot.before(note);
          }
          lastBids = it.bids;
          const p = pollRoot.querySelector('[data-price]'); if (p) p.textContent = it.price;
        }
        const card = !detailId && pollRoot.querySelector(`[data-item="${it.id}"]`);
        if (card) {
          card.querySelector('[data-price]').textContent = it.price;
          card.querySelector('[data-bids]').textContent = `${it.bids} bid${it.bids === 1 ? '' : 's'}`;
        }
      }
    } catch (_) { /* offline — try again next time */ }
  }
  poll(); setInterval(poll, 15000);
})();
