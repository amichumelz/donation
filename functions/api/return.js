/**
 * GET /api/return
 * Gateway bawa penderma balik ke sini selepas bayar.
 * Kita sahkan checksum, kemudian redirect ke laman utama dengan
 * parameter bersih supaya index.html boleh papar resit.
 *
 * Bayarcash v3 : GET dengan query params + checksum
 * toyyibPay    : GET dengan status_id, billcode, order_id
 *
 * Selepas status disahkan 'success', jumlah keseluruhan (KV key "totals")
 * di-increment SEKALI SAHAJA bagi setiap order — guna status order dalam
 * KV ("order:<ref>") sebagai penanda supaya refresh/back button pada
 * halaman ini tak kira derma yang sama dua kali.
 *
 * NOTA KESELAMATAN: untuk toyyibPay, return_url ini TIADA checksum
 * (toyyibPay hanya sediakan checksum pada callback_url server-to-server).
 * Jadi status_id di sini boleh secara teori dipalsukan oleh sesiapa yang
 * tahu order_id. Untuk perlindungan penuh, buat juga /api/callback yang
 * disahkan server-to-server dan pindahkan logik increment ke situ untuk
 * toyyibPay. Bayarcash pula selamat sebab checksum disahkan di bawah.
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
const TOTALS_KEY = 'totals';
const DEFAULT_TOTALS = { raised: 8000, donors: 160 };

/** Tambah satu derma ke jumlah keseluruhan dalam KV. */
async function incrementTotals(env, amount) {
  const stored = (await env.DONATIONS.get(TOTALS_KEY, 'json')) || DEFAULT_TOTALS;
  const updated = {
    raised: Number((stored.raised + amount).toFixed(2)),
    donors: stored.donors + 1,
  };
  await env.DONATIONS.put(TOTALS_KEY, JSON.stringify(updated));
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = url.searchParams;
  const provider = (env.PAYMENT_PROVIDER || 'bayarcash').toLowerCase();
  let siteUrl = String(env.SITE_URL || url.origin).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(siteUrl)) siteUrl = 'https://' + siteUrl;

  let status = 'failed', ref = '', amount = '', name = '', campaign = '';

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

  // Ambil rekod order dari KV — untuk nama peribadi DAN untuk elak double-count
  if (env.DONATIONS && ref) {
    const rec = await env.DONATIONS.get(`order:${ref}`, 'json');
    if (rec) {
      if (rec.name) name = rec.anonymous ? 'Anonymous' : rec.name;
      if (rec.amount && !amount) amount = String(rec.amount);
      if (rec.campaign) campaign = rec.campaign;
    }

    if (status === 'success' && rec && rec.status !== 'success') {
      // Tanda order ini sudah dikira, supaya refresh page tak tambah lagi
      await env.DONATIONS.put(
        `order:${ref}`,
        JSON.stringify({ ...rec, status: 'success', confirmedAt: new Date().toISOString() })
      );
      const amt = Number(amount) || Number(rec.amount) || 0;
      if (amt > 0) await incrementTotals(env, amt);
    }
  }

  const params = new URLSearchParams({ pay: status, ref });
  if (amount) params.set('amount', amount);
  if (name) params.set('name', name);
  if (campaign) params.set('campaign', campaign);

  return Response.redirect(`${siteUrl}/?${params.toString()}`, 302);
}
