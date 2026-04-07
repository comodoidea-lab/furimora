import webpush from 'web-push';

export const config = { runtime: 'nodejs' };

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, data) {
  setCors(res);
  res.status(status).json(data);
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const pub = process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '';
  const pri = process.env.WEB_PUSH_VAPID_PRIVATE_KEY || '';
  const contact = process.env.WEB_PUSH_CONTACT || 'mailto:admin@example.com';
  if (!pub || !pri) {
    sendJson(res, 500, { error: 'WEB_PUSH_VAPID_* is not configured' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid json' });
    return;
  }

  const sub = body?.subscription;
  if (!sub?.endpoint) {
    sendJson(res, 400, { error: 'subscription required' });
    return;
  }

  webpush.setVapidDetails(contact, pub, pri);
  const payload = JSON.stringify({
    title: body?.title || 'フリモーラ',
    body: body?.body || 'テスト通知です',
    url: body?.url || '/',
  });

  try {
    await webpush.sendNotification(sub, payload, { TTL: 60, urgency: 'high' });
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, {
      error: e?.message || 'push failed',
      statusCode: e?.statusCode || null,
      details: e?.body || null,
    });
  }
}
