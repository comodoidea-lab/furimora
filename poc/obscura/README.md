# Obscura 適合性 PoC

[Obscura](https://github.com/h4ckf0r0day/obscura)（Rust 製ヘッドレスブラウザ）で Chrome 拡張を
置き換えられるかを検証するための独立 PoC。**本体（`public/` / `api/`）には一切統合していない。**

## 実行

```bash
cd poc/obscura
npm install
npm run setup   # Obscura 公式リリースバイナリを obscura-bin/ に取得
npm run poc
```

`npm run setup` は GitHub Releases から約 80MB のアーカイブを取得する。
アカウント操作・出品操作は PoC では一切行わない（商品ページの閲覧のみ）。

## 構成

| ファイル | 役割 |
|---|---|
| `src/obscura-process.mjs` | `obscura serve` の子プロセス管理。SIGTERM → タイムアウト後 SIGKILL で孤児を残さない |
| `src/browser-service.mjs` | BrowserService 抽象層。Obscura 固有コードはここに閉じ込める |
| `src/testpage.mjs` | 入力・クリック検証用のローカルテストページ |
| `run-poc.mjs` | 18 項目の検証シナリオ |
| `probe-input.mjs` / `probe-key.mjs` | 入力系 CDP メソッドの対応状況の切り分け |

## 検証結果（2026-09-01 / Obscura v0.2.1 / macOS Apple Silicon）

16/18 成功。詳細は [`../../docs/obscura-migration-report.md`](../../docs/obscura-migration-report.md)。

### 動くもの

- Obscura 起動 / `chromium.connectOverCDP()` 接続 / プロセスの確実な終了
- `Page.navigate`、`Runtime.evaluate`、`DOM.*`、`Network.getAllCookies`、`Input.dispatchMouseEvent`
- クリック、`waitForSelector`、`boundingBox`、可視性判定
- `--storage-dir` による Cookie 永続化と、プロセス再起動後の復元

### 動かないもの

- **`Input.insertText` が未実装**、`Input.dispatchKeyEvent` は input の value を更新しない
  → Playwright の `fill()` / `type()` / `pressSequentially()` が全てタイムアウトする。
  `src/browser-service.mjs` の `fill()` はネイティブ value setter + `input`/`change` 発火へ
  フォールバックして回避している。
- **メルカリ商品ページの本文が描画されない。** 25 秒待っても `data-testid="loading-skeleton"` の
  まま `#main` の本文が 0 文字。ヘッダ等のシェルは描画されるが商品部分に到達しない。
  商品データはクライアント側の API 取得で入るため、DOM からは 10 項目中 2 項目
  （`og:title` 由来のタイトルと `og:image` 由来の 1 枚目画像）しか取れない。
