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
| `mercari_check_login` | — | 専用プロファイルがメルカリにログイン済みかを確認 |
| `mercari_login` | `wait_seconds` | ログイン用のブラウザを開く（入力は人間が行う） |
| `mercari_get_my_listings` | `tab`, `max_items` | 自分の出品一覧を取得（読み取りのみ） |

`url` は共有文のまま渡してよい（`merc.li` 短縮URLも可）。サーバー側で URL 部分を抽出する。

**閲覧のみ。** 出品・価格変更・削除は行わない。

## 自分の出品一覧（要ログイン）

`mercari_get_my_listings` はフリモーラ専用の Chrome プロファイル
（`~/.furimora/chrome-profile`）を起動して mypage を読む。**普段使っている Chrome には触れない。**

```
mercari_check_login        → 未ログインなら loggedIn:false
mercari_login              → ブラウザが開くので人間が一度ログインする（2段階認証も人間が通す）
mercari_get_my_listings    → 以降はセッションが再利用される
```

`tab` は `active`=出品中 / `in_progress`=取引中 / `sold`=売却済み / `history`=販売履歴。

注意: メルカリ側のルート名が直感と食い違っている（実機確認済み）。
`/mypage/listings/completed` が「売却済み」、`/mypage/listings/sold` が「販売履歴」。
この対応は `src/mercari-service.mjs` の `LISTING_TABS` に集約してある。

### 取得の速さ（2026-09-01 実測）

初回 50 件が 1 ページに描画され、「もっと見る」1 クリックで +30 件・約 1.0 秒。
商品詳細ページを 1 件ずつ開く方式ではないので、300 件でも 10 秒程度で済む見込み。

`truncated: true` が返った場合は上限で打ち切っている（`max_items` を上げる）。

### DOM 依存について

メルカリ固有のセレクタと抽出ロジックは `src/mercari-service.mjs` **だけ**に置いている。
UI 変更で壊れたときは原則このファイルだけを直す。実機で確認した癖:

- 行は `<a href="/item/...">` ではない。商品 ID は要素の属性値（遅延読み込み画像の src 等）に埋まっている
- `innerText` は非表示要素で空になるため `textContent` を使う
- 行の `textContent` は連結される（`¥1,9802日前に更新`）ので、価格と更新日はテキストノード単位で拾う
- 価格は `¥` と数字が別テキストノードに分かれることがある

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
