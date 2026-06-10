// Firebase Web SDK の公開設定。アクセス制御は Authentication と Firestore Rules で行う。
export const config = { runtime: 'edge' };

export default async function handler() {
  const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || '',
  };
  const webPushVapidPublicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '';
  /** OAuth 2.0 クライアント ID（Web）。Google Cloud で Drive API を有効化し、承認済み JavaScript 生成元にこのアプリの URL を登録する。 */
  const googleDriveClientId = process.env.GOOGLE_DRIVE_CLIENT_ID || '';
  const body = {
    configured: Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId && firebaseConfig.appId),
    firebaseConfig,
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
