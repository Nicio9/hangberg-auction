'use strict';
/**
 * Sends email through an HTTP email API (no extra packages needed).
 *   BREVO_API_KEY   -> Brevo (free tier: 300 emails/day)   https://www.brevo.com
 *   RESEND_API_KEY  -> Resend (free tier: 100 emails/day)  https://resend.com
 * With neither set, emails are printed to the server log (handy for testing).
 */
const FROM_EMAIL = process.env.MAIL_FROM_EMAIL || 'auction@example.org';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Hangberg Educational Trust Auction';

async function send({ to, subject, text, html }) {
  try {
    if (process.env.BREVO_API_KEY) {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { email: FROM_EMAIL, name: FROM_NAME }, to: [{ email: to }], subject, textContent: text, htmlContent: html })
      });
      if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
    } else if (process.env.RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: `${FROM_NAME} <${FROM_EMAIL}>`, to: [to], subject, text, html })
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    } else {
      console.log(`\n--- EMAIL (not sent: no email provider configured) ---\nTo: ${to}\nSubject: ${subject}\n\n${text}\n------------------------------------------------------\n`);
    }
    return true;
  } catch (err) {
    console.error('Email failed:', to, subject, err.message);
    return false;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function wrap(title, paragraphs, button) {
  const text = paragraphs.join('\n\n') + (button ? `\n\n${button.label}: ${button.url}` : '');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1c2b36">
  <h2 style="color:#0b5d7a">${esc(title)}</h2>
  ${paragraphs.map(p => `<p style="line-height:1.5">${esc(p)}</p>`).join('')}
  ${button ? `<p><a href="${esc(button.url)}" style="display:inline-block;background:#0b5d7a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">${esc(button.label)}</a></p>
  <p style="font-size:12px;color:#667">If the button doesn't work, copy this link into your browser:<br>${esc(button.url)}</p>` : ''}
  <p style="font-size:12px;color:#667">${esc(FROM_NAME)}</p></div>`;
  return { text, html };
}

module.exports = { send, wrap };
