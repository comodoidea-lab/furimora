// api/image-proxy.js — mercdnの画像をプロキシしてCORSを回避
import { corsHeaders } from './lib/cors.js';

export const config = { runtime: 'edge' };

function parseAllowedImageUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  // ホスト名で判定（パスに文字列を含めるだけのバイパスを防ぐ）
  const okMercdn = h === 'mercdn.net' || h.endsWith('.mercdn.net');
  const okMercariImages = h === 'mercari-images.jp' || h.endsWith('.mercari-images.jp');
  if (!okMercdn && !okMercariImages) return null;
  return u;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const { searchParams } = new URL(req.url);
  const url = searchParams.get('url');
  if (!url) return new Response('url required', { status: 400 });

  const target = parseAllowedImageUrl(url);
  if (!target) {
    return new Response('not allowed', { status: 403 });
  }

  try {
    const res = await fetch(target.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return new Response('fetch failed', { status: res.status });

    const buffer = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'image/jpeg';

    return new Response(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        ...corsHeaders(),
      },
    });
  } catch (err) {
    console.error('[image-proxy]', err);
    return new Response('error', { status: 500 });
  }
}

