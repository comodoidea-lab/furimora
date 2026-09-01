# クローン導線の役割分担

最終更新: 2026-09-01

## 方針

**Chrome 拡張は廃止しない。人間用の導線として正式に残す。**
以前は廃止方針だったが、MCP 搭載を前提に整理した結果、廃止ではなく役割分担が正しいと判断した。

分けるのは「導線」であって「取得処理」ではない。取得処理は 1 箇所に集約したままにする。

```
人間の導線                              エージェントの導線
──────────────                        ──────────────────
Chrome拡張（デスクトップ）              MCP ツール呼び出し
URL貼り付け（全環境）                    （url を引数で受け取る）
クリップボード検知（デスクトップ/Android）
明示ペースト（iOS）           ┐   ┌──  クリップボード読み取り
OS共有・Share Target（Android）│   │    （人からの受け渡し時のみ）
                              ▼   ▼
                  FurimoraCloneService.fetchItem(url)
                                │
                          /api/mercari
                                │
              非公式 API（DPoP 署名）+ 商品ページ解析 をマージ
```

### エージェントはクリップボードを主経路にしない

MCP ツールは引数を取るので、`mercari_get_item({url})` のように URL を直接渡す。
クリップボードを経由すると状態が外部に依存して壊れやすくなる（他アプリの上書き、権限、並列実行の競合、
何が入っていたか追跡できない）。クリップボードは **人間 → エージェントの受け渡し**にだけ使う。

## 環境ごとの導線

| 環境 | 主導線 | 実装 |
|---|---|---|
| デスクトップ（メルカリのページ上） | **Chrome 拡張** | `chrome-extension/` |
| デスクトップ（アプリ側） | URL 貼り付け / クリップボード自動検知 | `fetchCloneData()` / `checkClipboardForMercari()` |
| Android | OS 共有・Share Target / クリップボード自動検知 | `manifest.json` の `share_target` / `checkClipboardForMercari()` |
| iOS | 明示ペースト（ボタン → 長押しペースト → 自動取得） | `pasteAndFetch()` / `onCloneUrlPaste()` |
| 全環境 | 共有文のまま貼り付け（`merc.li` 短縮 URL も可） | `FurimoraCloneService.extractUrl()` |

**iOS の制約**: iOS Safari は Web Share Target API に対応していないため、PWA を共有シートに
登録できない。`navigator.clipboard.readText()` は毎回システムの「ペースト」許可 UI を出すので、
自動検知も意図的に無効にしている（`navigate()` 内の `if (!isIOSDevice())`）。
iOS で共有シートから 1 タップにするには、ショートカット App かネイティブ化（Share Extension）が要る。

## 拡張と URL 経路のデータ同等性（2026-09-01 実測・5 商品）

拡張の `extractItemData()` を実商品ページで実行し、同じ商品の `/api/mercari` と突き合わせた結果。

| | 拡張 | `/api/mercari` |
|---|---|---|
| 充足項目 | 10/10 | 10/10 |
| タイトル・価格・説明文・商品状態・送料負担・配送方法・発送元・発送日数 | 完全一致 | 完全一致 |
| 画像 | `slice(0,12)` で **12 枚上限** | 上限なし（17 枚の商品で 17 枚） |
| カテゴリ | 先頭に「日本語 > 」のゴミが入る（`nav a` が言語切替リンクを拾う） | クリーン |
| カテゴリの深さ | 1 段深いことがある（5 件中 2 件） | 1 段浅いことがある |

**残る唯一の劣化はカテゴリの深さ**（`api/mercari.js` の `buildCategoryString()`）。
拡張の `__NEXT_DATA__` 経路はメルカリの App Router 化により既に機能しておらず、
現在は DOM スクレイピングだけで動いている。

## 拡張の機能一覧と本体側の状態

| # | 機能 | 本体側 | 備考 |
|---|---|---|---|
| 1 | 商品データ抽出 | ✅ 同等（`/api/mercari`） | 画像枚数は本体が優位 |
| 2 | クローン画面への受け渡し | ✅ `?mercari_url=` | 旧 `?clone_data=` も受理し続ける |
| 3 | 10% 値下げ | ✅ 上位互換（値下げモーダル・履歴・利益再計算・期日プッシュ） | |
| 4 | 写真一括保存 | ✅ File System Access API + `/api/image-proxy` | |
| 5 | URL / タイトルコピー | ✅ Step2 の各コピーボタン | |
| 6 | 統計表示 | ✅ ホーム画面 + Firestore 同期 | |
| 7 | 再出品リマインダ | ✅ Web Push | |
| 8 | メルカリページ上の 1 クリック導線 | ➖ 本体に相当なし | **拡張を残す理由がこれ** |

拡張が担う固有の価値は #8 のみ。デスクトップで出品作業中に、いま見ているページから 1 クリックで
クローン画面へ行けること。

## 内部 API（MCP 用の接続点）

`window.furimora.api` に名前付きオペレーションを公開している。

| オペレーション | 想定 MCP ツール名 | 引数 | 戻り値 |
|---|---|---|---|
| `mercari.getItem` | `mercari_get_item` | `{url}` | `{ok, data, completeness}` |
| `mercari.createCloneData` | `mercari_create_clone_data` | `{url}` | `{ok, data, completeness}` |
| `mercari.enrichCloneData` | — | `{data}` | `{ok, data, completeness}` |
| `mercari.extractUrl` | — | `{text}` | `{ok, data:{url}}` |

例外はすべて `{ok:false, code, message}` に畳んで返す
（`EMPTY_INPUT` / `BAD_URL` / `FETCH_FAILED` / `BAD_PARAMS` / `UNKNOWN_OPERATION` / `INTERNAL_ERROR`）。

### 実装場所: public/js/clone-service.js（ブラウザ / Node 共用の ESM）

```
public/js/clone-service.js
   ├── public/index.html   の <script type="module"> が読む   ← 人間の導線
   └── MCP サーバー         が import する                      ← エージェントの導線
```

環境差はコンストラクタ引数だけで吸収する。ビルド手順は無い。

```js
// ブラウザ（同一オリジンの /api/mercari を最優先、落ちていれば既知オリジンへ）
createCloneService({ useRelativeApi: true, apiOrigins: [PRIMARY, LEGACY] })

// Node / MCP サーバー
createCloneService({ apiOrigins: ['https://furimora.vercel.app'] })

// テスト（fetch を差し替え可能）
createCloneService({ apiOrigins: ['...'], fetchImpl: async () => ({ ok: true, json: async () => ({...}) }) })
```

`createInternalApi(service)` が `list()` / `call(name, params)` を持つディスパッチャを返す。
純関数（`extractUrl` / `normalize` / `completeness` 等）は個別に named export しているので
単体テストから直接呼べる。

**MCP 側に取得ロジックを二重に書かないこと。** 追加は必ずこのファイルに入れる。

### MCP サーバー: mcp/

`mcp/server.mjs`（stdio）が `clone-service.js` を import して MCP ツールとして公開する。
セットアップと詳細は [../mcp/README.md](../mcp/README.md)。

| MCP ツール | 内部オペレーション |
|---|---|
| `mercari_get_item` | `mercari.getItem` |
| `mercari_create_clone_data` | `mercari.createCloneData` |
| `mercari_extract_url` | `mercari.extractUrl` |
| `furimora_status` | （`/api/health` への疎通確認のみ） |

`server.mjs` にあるのは MCP の型定義と、内部 API の戻り値を MCP レスポンスへ変換する処理だけ。
業務ロジックは持たない。`cd mcp && npm run check` でプロトコル越しの動作確認ができる。

**依存は `mcp/package.json` に閉じている**（`@modelcontextprotocol/sdk` と `zod`）。
ルートの `package.json` は変更していないので、Vercel のデプロイには影響しない。

なお `public/sw.js` は `/js/` を network-first で扱う（cache-first だとこのファイルを更新しても
古い版が配られ続けるため）。

## やらないこと

- ブックマークレット等の外部補助ツールを導線として採用しない（初代フリモーラの旧方式であり、
  Chrome 拡張へ移行した経緯がある。戻さない）
- MCP 専用の取得ロジックを別に作らない
