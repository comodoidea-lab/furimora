# フリモーラ MCP サーバー

フリモーラの内部 API を MCP ツールとして AI エージェントへ公開する stdio サーバー。

**取得ロジックはここに無い。** すべて [`../public/js/clone-service.js`](../public/js/clone-service.js)
に着地する。PWA の UI と同じ実装を共有しており、MCP 専用のロジックは持たない
（`server.mjs` にあるのは MCP の型定義と、内部 API の戻り値を MCP レスポンスへ変換する処理だけ）。

```
人間の導線                          エージェントの導線
Chrome拡張 / URL貼り付け /            この MCP サーバー
クリップボード / 共有シート            （url を引数で受け取る）
        └──────────┬──────────┘
        clone-service.js → /api/mercari
```

## セットアップ

```bash
cd mcp && npm install
```

Claude Code に登録:

```bash
claude mcp add furimora node /Users/tomoya/GitHub/furimora/mcp/server.mjs
```

Claude Desktop の場合は `~/Library/Application Support/Claude/claude_desktop_config.json` に:

```json
{
  "mcpServers": {
    "furimora": {
      "command": "node",
      "args": ["/Users/tomoya/GitHub/furimora/mcp/server.mjs"]
    }
  }
}
```

ローカルの `vercel dev` を向ける場合は環境変数で切り替える:

```bash
FURIMORA_API_ORIGIN=http://localhost:3000 node mcp/server.mjs
```

## ツール

| ツール | 引数 | 用途 |
|---|---|---|
| `mercari_get_item` | `url` | 商品URLから商品情報を取得（10項目 + 画像URL一覧） |
| `mercari_create_clone_data` | `url` | クローン出品用のデータ一式を組み立て、充足度を返す |
| `mercari_extract_url` | `text` | 共有文・クリップボードの中身から商品URLだけを抽出 |
| `furimora_status` | — | バックエンド（`/api/health`）への疎通確認 |

`url` は共有文のまま渡してよい（`merc.li` 短縮URLも可）。サーバー側で URL 部分を抽出する。

**閲覧のみ。** 出品・価格変更・アカウント操作は行わない。メルカリへのログインもしない。

## 動作確認

```bash
cd mcp && npm run check
```

MCP クライアントとして `server.mjs` を実際に起動し、プロトコル越しにツール一覧・正常系・
異常系（不正URL / 型違反 / 必須項目欠落 / 未知のツール）を検証する。

## セキュリティ

- **stdio トランスポートのみ。** ネットワークを一切 listen しない。MCP クライアントが
  子プロセスとして起動し、stdin/stdout でだけ会話する（HTTP ポートを開く実装ではないため、
  「localhost 限定」よりさらに攻撃面が狭い）
- 認証情報を扱わない。Cookie もセッションも持たない
- stdout は JSON-RPC 専用。ログは stderr にのみ出し、商品データや引数の中身は出さない
