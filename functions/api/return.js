/**
 * GET /api/return
 * Gateway bawa penderma balik ke sini selepas bayar.
 * Kita sahkan checksum, kemudian redirect ke laman utama dengan
 * parameter bersih supaya index.html boleh papar resit.
 *
 * Bayarcash v3 : GET dengan query params + checksum
 * toyyibPay    : GET dengan status_id, billcode, order_id
 */

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const BAYARCASH_STATUS = { 0: 'pending', 1: 'pending', 2: 'failed', 3: 'success', 4: 'cancelled' };
const TOYYIBPAY_STATUS = { 1: 'success', 2: 'pending', 3: 'failed', 4: 'pending' };

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = url.searchParams;
  const provider = (env.PAYMENT_PROVIDER || 'bayarcash').toLowerCase();
  let siteUrl = String(env.SITE_URL || url.origin).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(siteUrl)) siteUrl = 'https://' + siteUrl;

  let status = 'failed', ref = '', amount = '', name = '';

  if (provider === 'toyyibpay') {
    status = TOYYIBPAY_STATUS[Number(q.get('status_id'))] || 'failed';
    ref = q.get('order_id') || q.get('billcode') || '';
    amount = q.get('amount') || '';
  } else {
    // ── Bayarcash: checksum return_url guna set field yang lebih pendek ──
    const payload = {
      transaction_id: q.get('transaction_id'),
      exchange_reference_number: q.get('exchange_reference_number'),
      exchange_transaction_id: q.get('exchange_transaction_id'),
      order_number: q.get('order_number'),
      currency: q.get('currency'),
      amount: q.get('amount'),
      payer_bank_name: q.get('payer_bank_name'),
      status: q.get('status'),
      status_description: q.get('status_description'),
    };
    const message = Object.keys(payload).sort().map((k) => payload[k]).join('|');
    const expected = await hmacHex(env.BAYARCASH_SECRET_KEY || '', message);
    const ok = expected === (q.get('checksum') || '');

    status = ok ? BAYARCASH_STATUS[Number(q.get('status'))] || 'failed' : 'failed';
    ref = q.get('order_number') || '';
    amount = q.get('amount') || '';
    if (!ok) console.warn('return_url checksum mismatch', ref);
  }

  // Ambil nama dari KV kalau ada, supaya resit nampak peribadi
  if (env.DONATIONS && ref) {
    const rec = await env.DONATIONS.get(`order:${ref}`, 'json');
    if (rec?.name) name = rec.anonymous ? 'Anonymous' : rec.name;
  }

  const params = new URLSearchParams({ pay: status, ref });
  if (amount) params.set('amount', amount);
  if (name) params.set('name', name);

  return Response.redirect(`${siteUrl}/?${params.toString()}`, 302);
}
