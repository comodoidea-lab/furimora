// ブラウザに公開してよい Supabase URL / anon key（RLS で保護）。リポジトリには書かず環境変数で渡す。
export const config = { runtime: 'edge' };

export default async function handler() {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
  const webPushVapidPublicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '';
  /** OAuth 2.0 クライアント ID（Web）。Google Cloud で Drive API を有効化し、承認済み JavaScript 生成元にこのアプリの URL を登録する。 */
  const googleDriveClientId = process.env.GOOGLE_DRIVE_CLIENT_ID || '';
  const body = {
    configured: Boolean(supabaseUrl && supabaseAnonKey),
    supabaseUrl: supabaseUrl || null,
    supabaseAnonKey: supabaseAnonKey || null,
    webPushVapidPublicKey: webPushVapidPublicKey || null,
    googleDriveClientId: googleDriveClientId || null,
  };
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
