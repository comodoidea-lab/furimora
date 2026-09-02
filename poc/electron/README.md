# フェーズ0 PoC — Electron から localStorage が触れるか

**PoC 限定。製品コードではない。** 認証方式の変更も既存コードの変更も行っていない。
3 項目を確かめて記録するのが目的で、**ここで止める**。

```bash
cd poc/electron && npm install && npm start
```

ウィンドウが開くのでログインする。検知すると `result.json` を書いて終了する。

## 結果（2026-09-03 / Electron 33.4.11 / Chromium 130.0.6723.191）

| | 結果 |
|---|---|
| 1. `https://furimora.vercel.app` が開くか | ✅ タイトル・オリジンとも正常。`furimoraCurrentUser` も生きている |
| 2. ログインが通るか | ✅ **`provider: google.com` で成功** |
| 3. `executeJavaScript` で `furimora_drafts` が読めるか | ✅ **83,945 bytes / 50 件 / 先頭「裏切りのサーカス [Blu-ray]」** |

`did-fail-load` は 0 件。

**3 が読めたことで「MCP から localStorage が読めない」制約が Electron では消えることが実証された。**
Firestore 同期も効いており、Vivaldi で作った下書きがそのまま降りてきている。

## 実データで分かったこと

### パスキーは Electron で通らない

**警戒していた `disallowed_useragent`（Google が埋め込みブラウザを拒否）は起きなかった。**
ポップアップ（`https://furimora-app.firebaseapp.com/__/auth/handler`）は開き、Google は
Electron を受け入れた。

止まったのは**パスキーの段**で、「Bluetooth がオンになっていて、デバイス同士が近くにある
ことを確認します」で失敗した。WebAuthn のハイブリッド認証（BLE 経由）は Chrome にはあるが
**Electron は実装していない**。「別の方法を試す」で回避してログインは成功した。

- セッションは `persist:furimora-poc` に残るので**初回だけの問題**
- ただし「セッションが切れたとき素直に入り直せない」のは運用上の弱点。残件として残す
- **認証方式は変更していない。** Google 側のフロー内の選択肢を使っただけ

### COOP の警告が大量に出る（実害なし）

`Cross-Origin-Opener-Policy policy would block the window.closed call.` が 17 回。
Firebase の `signInWithPopup` と COOP の既知の組み合わせで、**ログインは成功している**。

### 本番配信のタイムラグで下書きが 1 件消えた

読み取れた件数が **50 のまま**だった。`FURIMORA_DRAFTS_MAX = 150` は本番に出ているが、
クローンした時点ではまだ旧コード（`slice(0, 50)`）が配信されていたため、最古の 1 件が
押し出された。**消えたのは「ノッキン・オン・ヘブンズ・ドア [レンタル落ちDVD]」**
（2026-05-27 / `m20403256987`）。`furimora-backup-2026-09-02.json` には残っている。

50 件上限の実害が実際に出た記録として残す。次のクローンからは 51 件になる。

## ここで止める

MCP サーバーの搭載も `FurimoraService` も書いていない。着手は別途判断する。
