/**
 * GET /api/tiktok
 * Pulangkan senarai video TikTok terbaharu untuk laman utama.
 *
 * Environment variables (Cloudflare Pages > Settings > Variables and Secrets):
 *   TIKTOK_HANDLE      (Plain) - cth. amalsatuhati  (tanpa @)
 *   TIKTOK_VIDEO_URLS  (Plain) - URL video dipisah koma, terbaharu dahulu.
 *      cth. https://www.tiktok.com/@syahmeerahim/video/7301234567890123456
 *      Short link (https://vt.tiktok.com/XXXX/) pun diterima —
 *      Function akan ikut redirect untuk dapatkan ID sebenar.
 *
 * Kenapa senarai URL dan bukan auto-fetch?
 * TikTok tidak benarkan sesiapa tarik senarai video akaun tanpa OAuth.
 * Untuk auto-fetch penuh anda perlu mohon TikTok Display API (Login Kit)
 * — lihat nota di bawah fail ini.
 *
 * Optional binding: KV namespace "SITE" — kalau ada, key "tiktok:urls"
 * akan diguna dahulu, jadi anda boleh update video tanpa deploy semula.
 */

const CACHE_SECONDS = 1800; // 30 minit

export async function onRequestGet({ request, env, waitUntil }) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const handle = (env.TIKTOK_HANDLE || 'amalsatuhati').replace('@', '');

  let raw = env.TIKTOK_VIDEO_URLS || '';
  if (env.SITE) {
    const fromKV = await env.SITE.get('tiktok:urls');
    if (fromKV) raw = fromKV;
  }

  // Terima URL penuh dan juga short link (vt./vm./tiktok.com/t/)
  const rawUrls = raw
    .split(/[,\n]/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\/([a-z]{2}\.)?tiktok\.com\//.test(u))
    .slice(0, 8);

  /** Panggil oEmbed rasmi TikTok — public, tiada API key */
  async function oembed(url) {
    try {
      const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AmalSatuHati/1.0)' },
        cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
      });
      if (!res.ok) return null;
      const d = await res.json();
      return d && d.thumbnail_url ? d : null;
    } catch {
      return null;
    }
  }

  /** Ikut redirect short link untuk dapatkan URL penuh /video/<id> */
  async function expand(url) {
    try {
      const r = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      });
      return r.url && /\/video\/\d+/.test(r.url) ? r.url.split('?')[0] : null;
    } catch {
      return null;
    }
  }

  const videos = (
    await Promise.all(
      rawUrls.map(async (input) => {
        let url = input;
        let d = null;

        // Short link: expand dahulu, sebab oEmbed lebih dipercayai dengan URL penuh
        if (!/\/video\/\d+/.test(url)) {
          const full = await expand(url);
          if (full) url = full;
        }

        d = await oembed(url);
        if (!d && url !== input) d = await oembed(input); // cuba semula dengan short link asal
        if (!d) return null;

        const id = (url.match(/video\/(\d+)/) || [])[1] || d.embed_product_id || null;
        return {
          id,
          url: d.author_url && id ? `${d.author_url}/video/${id}` : url,
          title: d.title || '',
          cover: d.thumbnail_url || '',
          author: d.author_name || handle,
        };
      })
    )
  ).filter(Boolean);

  // handle sebenar dari video kalau ada, bukan nilai default
  const derived = videos.find((v) => /tiktok\.com\/@([^/]+)/.test(v.url));
  const realHandle = derived ? derived.url.match(/tiktok\.com\/@([^/]+)/)[1] : handle;

  const response = new Response(JSON.stringify({ handle: realHandle, videos, configured: rawUrls.length }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
    },
  });

  waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

/* ------------------------------------------------------------------
 * NOTA: auto-fetch sepenuhnya (tiada senarai manual)
 * ------------------------------------------------------------------
 * 1. Daftar app di https://developers.tiktok.com, mohon skop
 *    "video.list" (Display API). Kelulusan ambil masa beberapa hari.
 * 2. Selesaikan OAuth sekali, simpan refresh_token sebagai secret.
 * 3. Ganti bahagian atas dengan:
 *
 *    const tok = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
 *      method: 'POST',
 *      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
 *      body: new URLSearchParams({
 *        client_key: env.TIKTOK_CLIENT_KEY,
 *        client_secret: env.TIKTOK_CLIENT_SECRET,
 *        grant_type: 'refresh_token',
 *        refresh_token: env.TIKTOK_REFRESH_TOKEN,
 *      }),
 *    }).then((r) => r.json());
 *
 *    const list = await fetch(
 *      'https://open.tiktokapis.com/v2/video/list/?fields=id,title,cover_image_url,share_url',
 *      {
 *        method: 'POST',
 *        headers: {
 *          Authorization: `Bearer ${tok.access_token}`,
 *          'Content-Type': 'application/json',
 *        },
 *        body: JSON.stringify({ max_count: 4 }),
 *      }
 *    ).then((r) => r.json());
 *
 * 4. Map list.data.videos -> {id, url: share_url, title, cover: cover_image_url}
 *
 * Refresh token tamat tempoh (~365 hari), jadi simpan yang baharu
 * dalam KV setiap kali ia ditukar.
 * ------------------------------------------------------------------ */
