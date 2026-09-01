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
| `furimora_reconcile_listings` | `backup_path` or `app_items` | 在庫とメルカリの出品を突き合わせてズレを検出 |
| `mercari_update_price` | `item_id`, `new_price`, `dry_run`, `min_price` | 出品 1 件の価格を変更（**既定は確認のみ**） |
| `furimora_list_drafts` | `backup_path` | フリモーラの下書き一覧（読み取りのみ） |
| `mercari_prepare_draft_from_furimora_draft` | `backup_path`, `draft_id` or `index` | **正規の順序。** フリモーラの下書きから引数を下ごしらえする |
| `mercari_resolve_category` | `category` | カテゴリーの経路が出品ツリーに実在するか調べる（読み取りのみ） |
| `mercari_prepare_draft_from_item` | `url` | 商品URLから直接下ごしらえする（フリモーラ側の確認を挟まない） |
| `mercari_create_draft` | `title`, `description`, `price`, `category_path`, `condition`, `image_paths`, `dry_run` | メルカリの**下書き**を 1 件作る（**既定は確認のみ。出品はしない**） |

`url` は共有文のまま渡してよい（`merc.li` 短縮URLも可）。サーバー側で URL 部分を抽出する。

**出品・削除・出品停止は行わない。** メルカリ側を変えうるのは 2 つだけで、どちらも既定は確認のみ:
価格変更（`mercari_update_price`）と、**下書きの作成**（`mercari_create_draft`）。
下書きは出品ではないので、誰にも見えない。「出品する」ボタンにはコードから一切触れない。

## 価格変更（唯一の書き込み操作）

`mercari_update_price` はメルカリの商品編集ページ（`/sell/edit/<itemId>`）を操作する。
**このサーバーで唯一、メルカリ側を変更しうるツール。**

```
mercari_update_price({ item_id, new_price })              → 確認のみ。何も変更しない
mercari_update_price({ item_id, new_price, dry_run:false }) → 実際に変更する
```

確認モードの戻り値には現在価格・新価格・差額・方向（値下げ/値上げ）と、
手数料・利益の見積り（現在の表示から送料等の控除を逆算して算出）が入る。

### 安全側の設計

- **`dry_run` の既定は `true`。省略時は絶対に実行しない**
- 1 回の呼び出しで変更できるのは **1 商品だけ**。一括変更の口は用意しない
- `min_price` を指定すると、それを下回る変更を `BELOW_MIN_PRICE` で拒否する
- 価格範囲（300〜9,999,999）を外れる指定はスキーマ段階で弾く
- 入力後に価格欄の値を読み直し、一致しなければ**保存ボタンを押さずに中断**する
- 保存後は編集ページを開き直して価格を検証する。一致しなければ `VERIFY_FAILED` を返す
- 削除ボタン・出品停止ボタンにはコードから一切触れない
  （誤操作防止のため `SELECTORS.dangerousButtons` に名前だけ記録してある）

### 検証状況

`node check-price.mjs` — 確認モードとガードの検証（**実際の価格変更は行わない**）。
実データで確認済み: 省略時は `applied:false`、実行後に一覧を取り直して価格が
変わっていないことを確認、最低価格・下限・不正ID・存在しない商品・同一価格の各ガード。

書き込み経路も実在の出品で確認済み（2026-09-01、1 円だけ動かして元に戻す手順）:

```
確認モード  ¥770 / 計画 -1 / applied=false     何も変更しない
実行        applied=true / ¥770 → ¥769         編集ページを開き直して検証
一覧確認    ¥769                                別経路でも反映を確認
復元        applied=true / ¥769 → ¥770         元の価格に戻す
```

手数料と利益の見積りも一致（¥77 → ¥76 / 利益は ¥693 のまま。
`floor(770×0.1)=77` で 693、`floor(769×0.1)=76` で 693）。

**書き込みを伴う検証は毎回人間の承認を通すこと。** 自動テストには含めない。

## 下書きの作成（出品はしない）

`mercari_create_draft` は出品フォーム（`/sell/create`）を埋めて **メルカリの「下書き」** を 1 件作る。

```
① フリモーラの下書き   既存（クローン機能）
② メルカリの下書き     ← このツールのゴール。まだ誰にも見えない
③ 出品する             人間が押す
```

```
mercari_create_draft({ title, description, price, category_path, condition })
  → 確認のみ。メルカリ側には何も保存しない
mercari_create_draft({ ..., dry_run:false })
  → 実際に下書きを作る
```

### 確認モードは「保存直前までの通し稽古」

メルカリに自動保存は無く、`下書きに保存する` を押すまで下書きは 1 件も作られない（実データで確認済み）。
そのため確認モードでも**フォーム入力とカテゴリー選択を実際に行う**。
結果としてカテゴリーの経路が実在するかどうかまで、保存せずに検証できる。

### 引数

| 引数 | 内容 |
|---|---|
| `category_path` | 大分類から末端までの**名前の配列**（例: `["ファッション","レディース","トップス","シャツ・ブラウス","半袖"]`）。経路が違えばその階層の候補を返す |
| `condition` | 1〜6。**大きいほど状態が悪い**。既定値は与えない。推測せず人間が決めた値を渡す |
| `image_paths` | ローカルのファイルパス。省略可 |

配送の方法・発送元・発送日数は**メルカリ側の既定値のまま**にする（配送の方法には既定で
「ゆうゆうメルカリ便」が入っている）。変更が要る場合は保存後に人間が直す。

### 正規の順序はフリモーラの下書きを経由する

```
① フリモーラの下書き   クローン機能で作り、フリモーラ側で確認・修正する
② メルカリの下書き     ← mercari_create_draft のゴール。まだ誰にも見えない
③ 出品する             人間が押す
```

**確認をメルカリ側でなくフリモーラ側で行うのは、修正のしやすさのため。**
①を飛ばすと、誤りに気づくのがメルカリに書き込んだ後になる
（実際に配送の方法が既定のまま保存された事例がある）。

```
furimora_list_drafts({ backup_path })
  → 下書き一覧から 1 件選ぶ
mercari_prepare_draft_from_furimora_draft({ backup_path, draft_id })
  → draftInput + needsHuman
mercari_create_draft({ ...draftInput, image_paths, dry_run:false })
```

#### 下書きの受け渡しはバックアップ JSON 経由

フリモーラの下書きは PWA の **localStorage（`furimora_drafts`）** にあり、
MCP サーバー（Node）からは直接読めない。設定画面の「バックアップをダウンロード」で
保存した JSON を `backup_path` で渡す。

**これは在庫データ（`furimora_items`）とまったく同じ制約・同じ回避策。**
機能を足すたびに同じ手渡しが増えるため、Electron 化（フェーズ0）の判断材料になる。

#### 下書きの値をそのまま使わない

`needsHuman` に価格・商品の状態・画像・配送の方法を必ず載せる。
**複製元の下書き自体が間違っていることがある**（実測: 発送日数が「2~3日」だったが、
実際の運用は「1~2日」だった）。発送日数はメルカリ側の既定のままにしており、コピーしない。

### 商品URLから直接下ごしらえする（フリモーラ側の確認を挟まない）

既存の商品URLから `mercari_create_draft` の引数を組み立てるには `mercari_prepare_draft_from_item` を使う。
**読み取りのみで、メルカリ側には何も作らない。**

```
mercari_prepare_draft_from_item({ url })
  → draftInput（title / description / category_path / condition）
  → needsHuman（人間が確定させる項目）
mercari_create_draft({ ...draftInput, price, condition, image_paths })
```

やっていること:

| 変換 | 内容 |
|---|---|
| `category`（`"A > B > C"`） | 出品ツリーを実際にたどって末端まで解決し、`category_path` にする |
| `condition`（`"新品、未使用"`） | 1〜6 の番号に対応づける。一致しなければ `null` |

**`price` は必ず `null` で返す。** クローン元の価格をそのまま使わせないため。
`condition` も対応づけはするが `needsHuman` に必ず載せる（実物を見て決めるもの）。
画像は取得元の URL では渡せない（`image_paths` はローカルのファイルパス）。

カテゴリーの経路だけを試したい場合は `mercari_resolve_category` を使う。
末端に届かない場合はその階層の候補を返す。**末端を推測して勝手に選ぶことはしない。**

```
mercari_resolve_category({ category: 'ファッション > レディース > トップス' })
  → CATEGORY_PATH_TOO_SHORT + 候補（シャツ・ブラウス / Tシャツ・カットソー / …）
```

#### 配送の方法

`shipping_method` に名前を渡すと選択する（例: `"らくらくメルカリ便"`）。
省略するとメルカリ側の既定（**ゆうゆうメルカリ便**）のままになる。

選択肢は `input[type=radio][name="selectedShippingMethod"]`。
**ラジオを選ぶだけでは反映されない。「更新する」を押して初めてフォームへ戻る**
（押さずに戻ると元の配送方法のまま。実測で踏んだ）。
一致する選択肢が無ければ**推測せず**候補を返す。

```
らくらくメルカリ便 / ゆうゆうメルカリ便 / 梱包・発送たのメル便
```

ゆうメール・レターパック等は「その他」（`shipping-service-trigger-button`）の奥にあり、
まだ対応していない。発送元・発送日数もメルカリ側の既定のままで、変更する口は用意していない。

#### 画像を渡すと AI 出品サポートのウィザードが始まる

**画像を渡すとモーダルが開き、`body` が `position:fixed` になる。**
閉じないとフォームの要素は「outside of the viewport」で一切押せない。実測の段:

```
① image-upload-step（出品画像の並べ替え）        → 「次へ」
② category-select-step（こちらのカテゴリーですか？）→ 「スキップ」
```

②は AI がカテゴリーを推測してくる画面。**採らずにスキップする**
（カテゴリーは下書きから確定しており、推測で決めてはいけないため）。
**未知の段に当たったら押さずに中断する。**

ほかに画像まわりで踏んだもの:

- 画像の行は DnD の都合で DOM に**二重に現れる**。枚数は testid の一意な数で数える
- 画像を載せるとフォームが縦に伸び、Playwright の自動スクロールだけでは押せない要素が出る。
  `clickInForm()` が押す前に必ず画面内へスクロールする
- 複製元の説明文は **CRLF** のことがあるが `textarea` は LF に正規化する。
  入力側を LF に揃えないと読み直しの照合が必ず食い違う

#### カテゴリーによっては /sell/wizard が挟まる

末端を選んだあと「購入者にあなたの商品を見つけやすくしませんか？」という
製品情報入力の画面（`/sell/wizard`）へ飛ぶことがある（実測: ゲーム・おもちゃ・グッズ >
キャラクターグッズ > その他）。これは**任意**の導線で、`back-to-listing-button`
（出品画面に戻る）で素通りできる。カテゴリー自体はこの時点で確定している。
`skipSellWizard()` が自動でこれを処理する。**製品情報の入力へは進まない。**

### 安全側の設計

- **`dry_run` の既定は `true`。省略時は絶対に保存しない**
- 1 回の呼び出しで作る下書きは **1 件だけ**
- 「出品する」ボタン（`list-item-button` / `list-draft-button`）には**コードから一切触れない**
  （誤操作防止のため `SELECTORS.draft.dangerousButtons` に名前だけ記録してある）
- 商品名・説明・価格の文字数上限は**ページから読む**（決め打ちにしない）
- 入力後に全項目を読み直し、一致しなければ**保存ボタンを押さずに中断**する
  （AI 出品サポートによる上書きもここで検出する）
- 保存後は下書きを開き直して内容を検証する。一致しなければ `VERIFY_FAILED` を返す

### 実データで分かっていること

- **画像なしでも下書きは保存できる**（一覧では NOIMAGE と表示される）
- **カテゴリー固有の属性（`dynamicAttributes`）は空でも保存できる。** 下書きには必須ではない
- つまり必須は **商品名・説明・価格・カテゴリー・商品の状態** の 5 つだけ
- 下書きの実体は `/sell/draft/<draftId>`。開き直して編集できる
- **AI 出品サポートが既定で ON。** 写真から商品名・説明文・価格を自動入力するため、
  画像を渡す場合は入力後の読み直しが効いてくる

### 検証状況

`node check-draft.mjs` — 確認モードとガードの検証（**下書きを 1 件も作らない**）。
スキーマ段階のガード（状態 0/7・価格の下限・小数・経路 1 段・必須欠落）、
実行時のガード（存在しない画像 / 存在しないカテゴリー / 末端まで届かない経路）、
確認モードで `saved:false` になること、カテゴリーと状態が実際に反映されること、
前後で下書き件数が増えていないことを確認する。

書き込み経路も実データで確認済み（2026-09-01、人間の承認のもと 1 件だけ作成し、確認後に削除）:
画像なし・`dynamicAttributes` 6 本すべて空で保存でき、開き直すと
商品名・説明・価格・カテゴリー（フルパス）・商品の状態・配送の方法がすべて残っていた。

**書き込みを伴う検証は毎回人間の承認を通すこと。** 自動テストには含めない。

## 専用プロファイルは同時に 1 プロセスまで

`~/.furimora/chrome-profile` は Chrome の ProcessSingleton で保護されている。
MCP サーバーと検証スクリプトが同時に掴もうとすると
`Failed to create a ProcessSingleton for your profile directory` で落ちる。
ブラウザを使う処理は**都度開いて閉じる**こと（`withMercari` はそうしている）。

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

### 取得の速さ（2026-09-01 実データで実測）

| タブ | 件数 | 所要 | 「もっと見る」 |
|---|---|---|---|
| 出品中 | 44 件 | 約 8 秒 | 0 回 |
| 売却済み | 319 件 | 約 21 秒 | 9 回 |

初回 50 件が 1 ページに描画され、「もっと見る」1 クリックで +30 件。
商品詳細ページを 1 件ずつ開く方式ではないので、件数が増えても線形に伸びるだけ。

`truncated: true` が返った場合は上限で打ち切っている（`max_items` を上げる）。

### DOM 依存について

メルカリ固有のセレクタと抽出ロジックは `src/mercari-service.mjs` **だけ**に置いている。
UI 変更で壊れたときは原則このファイルだけを直す。実機で確認した癖:

- 行は `<a href="/item/...">` ではない。商品 ID は要素の属性値（遅延読み込み画像の src 等）に埋まっている
- `innerText` は非表示要素で空になるため `textContent` を使う
- 行の `textContent` は連結される（`¥1,9802日前に更新`）ので、価格と更新日はテキストノード単位で拾う
- 価格は `¥` と数字が別テキストノードに分かれることがある
- 一覧の各行は `<li>`。リスト外に「おすすめ」商品が 1 件混ざるため `li` に限定して除外する
  （限定しないと 44 件のはずが 45 件になる）
- 描画は段階的。1 件でも取れた時点で打ち切ると取りこぼす（実データで 44 件中 1 件だった）。
  件数が 3 回連続で変わらなくなるまで待つ
- 「もっと見る」は読み込み中に一時的に消える。1 回見つからないだけで終了と判断してはいけない
  （実データで 319 件が 171 件に化けた）
- ページ内に「N件」表記が複数ある（44件/20件/1件/10件/3件）ので件数の手がかりに使えない

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

## 在庫との突き合わせ

`furimora_reconcile_listings` は、フリモーラの在庫データとメルカリの実際の出品を照合する。
**読み取りのみで、どちらのデータも変更しない。**

在庫データの渡し方は 2 通り:

- `backup_path` — 設定画面の「バックアップをダウンロード」で保存した JSON のパス
- `app_items` — 在庫アイテムの配列を直接

検出する項目:

| 項目 | 意味 |
|---|---|
| 売れているのに出品中のまま | メルカリでは売却済み、手元では出品中 ← **主目的** |
| 価格がズレている | 両方出品中だが価格が違う（`price_tolerance` で許容差を設定可） |
| メルカリから消えている | 手元は出品中だが、メルカリのどちらのタブにも無い |
| 再出品したのに売却済みのまま | 手元は売却済み、メルカリでは出品中 |
| 手元に無い出品 | メルカリにあるがフリモーラに未登録 |
| メルカリID未設定 | 商品URLが未設定で突き合わせできない |

**安全側の設計**: メルカリ側の取得が上限で打ち切られた場合（`truncated`）、
「メルカリから消えている」の判定は**行わない**。まだ読み込んでいないだけの商品を
「消えた」と誤報告しないため。その旨は `summary.notes` に出る。

### 照合ロジックは他プロジェクトでも使える

`public/js/reconcile.js` は依存ゼロの純粋関数で、フリモーラ固有の型に縛られていない。
フィールドの読み方は adapter で差し替えられるので、別の在庫管理アプリへそのまま持って行ける。

```js
import { reconcileListings } from './reconcile.js';
reconcileListings({
  local, remoteActive, remoteSold, remoteTruncated,
  adapter: { id: r => r.sku, price: r => r.listPrice, isActive: r => r.state === 'listed', ... },
});
```

単体テストは `node check-reconcile.mjs`（ログイン不要・合成データ・20 項目）。
