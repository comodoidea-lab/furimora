# Obscura 移行 調査・PoC レポート

作成日: 2026-09-01 / 対象: Obscura v0.2.1（macOS aarch64, stealth ビルド）/ 環境: macOS 25.6.0 Apple Silicon, Node v22.22.3

## 結論（先に）

| 目標 | 状態 |
|---|---|
| 第一目標: Chrome 拡張なしでクローン用の商品情報を取得 | ✅ **達成済み。ただし Obscura ではなく既存 `/api/mercari` 経路で。** |
| 第二目標: Obscura のセッション保持でログイン状態を再利用 | 🟡 **Cookie 永続の仕組みは動作確認済み。ただしメルカリのログイン画面到達は未検証（描画不能の可能性大）。** |
| 第三目標: MCP から同じ内部 API を呼び出す | ⛔ **着手保留。土台となる Obscura 経由の DOM 取得が成立しないため。** |

**Obscura は現時点でメルカリの商品ページを描画できない。** したがって「Chrome 拡張の DOM 取得を
Obscura の DOM 取得へ置き換える」という当初の移行方針はそのままでは成立しない。
一方で、**Chrome 拡張の廃止自体は Obscura を使わずに可能**であることが分かった（後述）。

## 1. 現状調査

### 技術構成

| レイヤ | 実体 |
|---|---|
| 本体 | 静的 PWA 単一ファイル `public/index.html`（7,484 行、Tailwind CDN）+ `public/sw.js` |
| サーバー | Vercel Edge Functions `api/`（`mercari.js` 728 行 / `image-proxy.js` / `push-send.js` / `public-config.js`） |
| データ | Firebase Auth + Firestore（delta sync）、localStorage |
| ネイティブ | `capacitor.config.json`（`webDir: public`） |
| 拡張 | `chrome-extension/` MV3（content 418 行 / background 135 行 / popup 89 行） |

**本体にローカル実行プロセスが存在しない。** ルート `package.json` の依存は `jose` / `web-push` のみ、
`npm run dev` は静的プレビューサーバー。Electron も Tauri もない。
つまり「フリモーラ本体に MCP サーバーと Obscura を内蔵する」ための**ホストプロセスが現状ない**。

### Chrome 拡張が担当している機能

| # | 機能 | 実装箇所 | 本体側の同等物 |
|---|---|---|---|
| 1 | メルカリ商品ページへのウィジェット注入 | `content.js` `createWidget()` | なし（拡張固有 UI） |
| 2 | 商品データ抽出 | `content.js` `extractItemData()`：`__NEXT_DATA__` → DOM の 3 段フォールバック | `api/mercari.js`（DPoP API + ページ解析） |
| 3 | クローン受け渡し | base64 JSON を `?clone_data=` で PWA へ | 受け側は `public/index.html:7426` に実装済み |
| 4 | 10% 値下げ | **クリップボードへコピーするだけ** + 統計記録 | ― |
| 5 | 写真一括保存 | `chrome.downloads.download` | File System Access API で実装済み（`public/index.html:5738`） |
| 6 | URL / タイトルコピー | `navigator.clipboard` | あり |
| 7 | 統計・再出品リマインダ | `chrome.storage.local` + `chrome.alarms` + `notifications` | Firestore + web-push |

### Chrome 依存 API と置換先

| Chrome API | 用途 | 置換先 |
|---|---|---|
| content script 注入 | ページ内 DOM 取得 | CDP `Runtime.evaluate`（※ 後述の理由で今回は不成立） |
| `chrome.runtime.sendMessage` | content ↔ background | ローカル HTTP / MCP |
| `chrome.tabs.*` | タブ操作 | CDP `Page.navigate` / `Target.*` |
| `chrome.storage.local` | 統計・アプリ URL | 既存 localStorage + Firestore |
| `chrome.downloads` | 画像保存 | 既存 File System Access API |
| `chrome.alarms` / `notifications` | 再出品通知 | 既存 web-push |

### 認証・Cookie・セッション依存

**拡張は Cookie にもログイン状態にも一切依存していない。**
`manifest.json` に `cookies` permission がなく、抽出対象（`__NEXT_DATA__` / DOM / og メタ）は
未ログインで閲覧できる公開情報のみ。**クローン機能にログインは不要。**

### 価格変更・出品操作の現状

**メルカリへの書き込み操作は一切実装されていない。**
「10% 値下げ」はクリップボードへのコピー、「再出品」は貼り付け支援 UI（`public/index.html:1358` 付近）。
したがって D（価格変更）/ E（出品操作）は *移植対象ではなく新規機能*。

## 2. Obscura 適合性の検証結果

`poc/obscura/run-poc.mjs` で 18 項目を実測（16/18 成功）。

### 動作したもの

| 項目 | 結果 |
|---|---|
| macOS Apple Silicon で動作 | ✅ `obscura 0.2.1`（公式リリースバイナリ、ビルド不要） |
| 子プロセスとしての起動 | ✅ `obscura serve --port N --host 127.0.0.1` |
| CDP 接続 | ✅ |
| Playwright 接続 | ✅ `chromium.connectOverCDP()`（`playwright-core` のみで可、ブラウザDL不要） |
| Cookie 保持 | ✅ `context.cookies()` / `addCookies()` |
| 永続セッション | ✅ `--storage-dir` → `cookies.json` 生成、別プロセス再起動後に復元を確認 |
| localStorage / sessionStorage | ✅ API 存在（`--storage-dir` に origin 別ファイル出力） |
| DOM 取得 | ✅ `evaluate` / `content()` / `waitForSelector` / `boundingBox` |
| クリック | ✅ `Input.dispatchMouseEvent` |
| 画面遷移 | ✅ `Page.navigate`（`load` / `networkidle` 対応） |
| プロセス終了 | ✅ SIGTERM でクリーン終了、孤児プロセス 0 を確認 |
| Web API 面 | ✅ `Worker` / `crypto.subtle` / `IndexedDB` / `MutationObserver` / `IntersectionObserver` / `customElements` すべて存在 |

### 動作しなかったもの

**(A) フォーム入力（テキスト）**

```
fill(force):              Timeout
type():                   Timeout
locator.pressSequentially: Timeout
keyboard.type():          Protocol error (Input.insertText): Unknown Input method: insertText
Input.dispatchKeyEvent:   受理されるが input の value は空のまま
evaluate + input イベント: ✅ 動作
```

`Input.insertText` が未実装、`Input.dispatchKeyEvent` も value を更新しない。
`poc/obscura/src/browser-service.mjs` の `fill()` はネイティブ value setter
（`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set`）+ `input`/`change` 発火へ
フォールバックさせて回避した。React の controlled input にも効く方式だが、
IME・キーイベント依存のバリデーションを持つフォームでは通らない可能性が残る。

**(B) メルカリ商品ページの描画 — これが決定的**

`https://jp.mercari.com/item/m15031621353` を 25 秒待って測定した結果:

```json
{
  "title": "【新品未開封】一番くじ VIVANT ラストワン賞 & F賞 小皿セット - メルカリ",
  "hasNextData": false, "nextF": 0,
  "mainTextLen": 0, "h1": null, "priceTestid": null, "descTestid": null,
  "testids": ["mercari-logo", "search-autocomplete", ..., "loading-skeleton"],
  "ogImage": "https://static.mercdn.net/item/detail/orig/photos/m15031621353_1.jpg?..."
}
```

ヘッダ・検索バーなどのシェルは描画されるが、**商品本体は `loading-skeleton` のまま**で
`#main` の本文が 0 文字。コンソールには `Dynamic script fetch error: HTTP 0`（10 件）と
`TypeError: Cannot set properties of undefined (setting 'onmessage')`
（`globalThis.__obscura_deliverMessage` 内、Obscura の bootstrap 層）が出る。

前提として、メルカリ Web は現在 Next.js App Router 化されており **`__NEXT_DATA__` は存在しない**。
商品データはクライアント側の API 取得で入るため、SSR された HTML には
og メタタグ以外の商品情報が含まれない（生 HTML 546KB を確認済み）。
Obscura はその API 取得を完走できていない。

結果、Obscura の DOM から取れるのは 10 項目中 2 項目のみ:

| 項目 | Obscura（DOM） | 既存 `/api/mercari` |
|---|---|---|
| タイトル | ✅ og:title | ✅ |
| 価格 | ❌ | ✅ 4,200 |
| 説明文 | ❌ | ✅ 397 文字 |
| カテゴリ | ❌ | ✅ 3 階層 |
| 商品状態 | ❌ | ✅ |
| 送料負担 / 配送方法 / 発送元 / 発送日数 | ❌ | ✅ |
| 画像 | 🟡 og:image の 1 枚のみ | ✅ 6 枚（orig 解像度） |
| | **2/10** | **10/10**（`source: merged`） |

なお `jp.mercari.com/robots.txt` は `/sell/`・`/mypage/`・`/transaction/` を Disallow としている
（商品ページは許可）。出品・価格変更を自動化する場合はこの点の判断が別途必要。

## 3. 機能単位の置換可否

| | 機能 | Obscura で置換 | 現実的な手段 |
|---|---|---|---|
| A | 商品情報取得 | ⛔ 不可（2/10 項目） | ✅ **既存 `/api/mercari` で 10/10 達成済み** |
| B | クローン作成 | ⛔ A に依存 | ✅ 既存 URL 貼り付け経路で成立（実機確認済み） |
| C | ログイン維持 | 🟡 Cookie 永続の仕組みは動作。ログイン画面自体の描画は未検証 | 保留 |
| D | 価格変更 | ⛔ 未実装機能。ページが描画できず入力系も制限あり | 保留 |
| E | 出品操作 | ⛔ 同上 | 保留 |

## 4. Chrome 拡張を廃止できるか

**できる。ただし Obscura ではなく、既存の本体機能で。**

実機で確認した内容（`https://furimora.vercel.app/?page=clone&url=...&autofetch=1`）:

```json
{"step2Visible": true, "title": "【新品未開封】一番くじ VIVANT ...",
 "price": "4200", "category": "ゲーム・おもちゃ・グッズ > キャラクターグッズ > その他",
 "condition": "新品、未使用", "descLen": 397, "images": 6, "error": null}
```

拡張が返す `clone_data` と同じ項目が、**URL を渡すだけで揃う**。
拡張固有の残り機能（画像一括保存・統計・通知）も本体側に同等実装が既にある。

拡張廃止で実際に失われるのは以下のみ:

1. メルカリのページ上に出るフローティング UI（ワンクリックでの起動導線）
2. API/スクレイプが将来ブロックされた場合の、ログイン済みブラウザによる DOM 取得という保険

## 5. 最大の技術リスク

1. **Obscura がメルカリ商品ページを描画できない。** 移行の前提が崩れる。上流の対応待ちか、
   Obscura 側の `__obscura_deliverMessage` / dynamic import 周りの修正が必要。
2. **ホストプロセスがない。** Obscura（実体 101MB のバイナリ）を子プロセス起動するには
   ユーザーの Mac 上で動く Node ランタイムが要る。Vercel 上の PWA からは起動できない。
   拡張を Obscura へ置き換えるなら、導入は「zip をインストール」から「ネイティブアプリを配布」へ
   重くなる。
3. `Input.insertText` 未実装。D / E（価格変更・出品）を自動化するなら影響が大きい。
4. `/api/mercari` は非公式 API（DPoP 署名）に依存している。ここが塞がれた場合、
   Obscura は現状バックアップにならない。

## 6. 推奨する進め方

**短期（Obscura 不要・低リスク）**

1. Chrome 拡張の商品情報取得を「本体の URL 貼り付け経路」に一本化する方針を確定する。
   実装はほぼ完了しているため、追加コードは最小。
2. 拡張のフローティング UI に相当する導線（クリップボード検知 / iOS 共有シート / Android の
   OS 共有・Share Target）は `public/index.html` に既にある。ここを案内として整備すれば拡張を落とせる。
   外部の補助ツールは代替導線として採用しない（詳細は chrome-extension-deprecation.md）。
3. `chrome-extension/content.js` の `extractItemData()` と `api/mercari.js` の正規化ロジックの
   重複を `api/mercari.js` 側へ一本化する。

**中期（Obscura を再評価する場合）**

4. Obscura 側に issue を立てる。再現条件は本 PoC で確定している
   （Next.js App Router のページで `loading-skeleton` のまま停止、`Input.insertText` 未実装）。
5. Obscura が商品ページを描画できるようになった時点で、`poc/obscura/src/browser-service.mjs` を
   `agent/` 配下へ昇格させ、その上に MercariService → ApplicationService → MCP を載せる。
   PoC の BrowserService は既にその形（Obscura 固有コードを 1 層に閉じ込め済み）で書いてある。

## 7. 未着手（意図的に止めた箇所）

指示の手順 4〜9（拡張の置換 / MercariService / MCP 内蔵 / セッション管理 / セキュリティ）は、
手順 3 の PoC が「メルカリ商品ページを Obscura で取得できる」という前提を満たさなかったため
**着手していない**。指示 4 の「PoC が成功したら移植」という条件に従っている。

セキュリティ要件（localhost 限定 / トークン認証 / Cookie をログに出さない / 子プロセス確実終了）は
PoC の範囲で以下だけ先行して実装済み:

- `obscura serve --host 127.0.0.1` 固定
- SIGTERM → 8 秒後 SIGKILL のプロセス終了、`process.on('exit'/'SIGINT'/'SIGTERM')` フック
- `BrowserService.cookieSummary()` は Cookie の値を出さず長さのみ返す
