/**
 * GET /api/tiktok
 * Pulangkan senarai video TikTok terbaharu untuk laman utama.
 *
 * Environment variables (Cloudflare Pages > Settings > Variables and Secrets):
 *   TIKTOK_HANDLE      (Plain) - cth. amalsatuhati  (tanpa @)
 *   TIKTOK_VIDEO_URLS  (Plain) - URL video dipisah koma, terbaharu dahulu.
 *      cth. https://www.tiktok.com/@amalsatuhati/video/7301234567890123456,
 *           https://www.tiktok.com/@amalsatuhati/video/7301234567890123457
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

  const urls = raw
    .split(/[,\n]/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\/(www\.)?(vm\.)?tiktok\.com\//.test(u))
    .slice(0, 8);

  // oEmbed rasmi TikTok — public, tiada API key diperlukan
  const videos = (
    await Promise.all(
      urls.map(async (url) => {
        try {
          const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, {
            headers: { 'User-Agent': 'AmalSatuHati/1.0' },
            cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
          });
          if (!res.ok) return null;
          const d = await res.json();
          const id = (url.match(/video\/(\d+)/) || [])[1] || d.embed_product_id;
          if (!id) return null;
          return {
            id,
            url,
            title: d.title || '',
            cover: d.thumbnail_url || '',
            author: d.author_name || handle,
          };
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean);

  const response = new Response(JSON.stringify({ handle, videos }), {
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
