// ZaikoBang は開発者本人だけが使う道具。API も本人の Firebase ログインがある呼び出しだけ通す。
// 誰でも叩けると、メルカリへの取得やプッシュ送信をよその人に使われる（IP ブロックや費用の原因になる）。
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'furimora-app';
// Firestore のルール（firestore.rules の isOwner）と同じ uid を並べる
const OWNER_UIDS = String(process.env.OWNER_UIDS || 'bteOJH42BGPTEXc2t2qFLoGwMiw2')
  .split(',').map((s) => s.trim()).filter(Boolean);

function readAuthHeader(req) {
  const h = req.headers;
  const v = typeof h?.get === 'function' ? h.get('authorization') : (h?.authorization || h?.Authorization);
  return String(v || '');
}

/** 本人なら null、それ以外は { status, error } を返す */
export async function checkOwner(req) {
  const m = readAuthHeader(req).match(/^Bearer\s+(.+)$/i);
  if (!m) return { status: 401, error: 'ログインが必要です' };
  try {
    const { payload } = await jwtVerify(m[1], JWKS, {
      issuer: `https://securetoken.google.com/${PROJECT_ID}`,
      audience: PROJECT_ID,
    });
    if (!OWNER_UIDS.includes(payload.sub)) return { status: 403, error: 'このツールは開発者専用です' };
    return null;
  } catch {
    return { status: 401, error: 'ログインを確認できませんでした' };
  }
}
