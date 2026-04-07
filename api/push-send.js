import webpush from 'web-push';

export const config = { runtime: 'nodejs' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  const pub = process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '';
  const pri = process.env.WEB_PUSH_VAPID_PRIVATE_KEY || '';
  const contact = process.env.WEB_PUSH_CONTACT || 'mailto:admin@example.com';
  if (!pub || !pri) return json({ error: 'WEB_PUSH_VAPID_* is not configured' }, 500);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const sub = body?.subscription;
  if (!sub?.endpoint) return json({ error: 'subscription required' }, 400);

  webpush.setVapidDetails(contact, pub, pri);
  const payload = JSON.stringify({
    title: body?.title || 'フリモーラ',
    body: body?.body || 'テスト通知です',
    url: body?.url || '/',
  });

  try {
    await webpush.sendNotification(sub, payload);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e?.message || 'push failed', statusCode: e?.statusCode || null }, 500);
  }
}
