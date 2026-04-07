// GET /api/health — デプロイ確認・ロードバランサ向け
import { corsHeaders } from './lib/cors.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }
  return new Response(
    JSON.stringify({
      ok: true,
      service: 'furimora-api',
      runtime: 'edge',
      time: new Date().toISOString(),
    }),
    { headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
  );
}
