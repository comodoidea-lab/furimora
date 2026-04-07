// ブラウザに公開してよい Supabase URL / anon key（RLS で保護）。リポジトリには書かず環境変数で渡す。
export const config = { runtime: 'edge' };

export default async function handler() {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
  const body = {
    configured: Boolean(supabaseUrl && supabaseAnonKey),
    supabaseUrl: supabaseUrl || null,
    supabaseAnonKey: supabaseAnonKey || null,
  };
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
