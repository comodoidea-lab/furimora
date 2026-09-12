# Firebase セットアップ

## 1. Firebase プロジェクト

現在のFirebase構成:

- Firebase project: `furimora-app`
- Firestore location: `asia-northeast1`
- Firestore delete protection: enabled
- Web app: `Furimora Web`
- Authentication: Google、メール/パスワード、メールリンク
- Production domain: `furimora.vercel.app`

Web アプリを追加し、表示された設定値を Vercel の環境変数へ登録します。

```text
FIREBASE_API_KEY
FIREBASE_AUTH_DOMAIN
FIREBASE_PROJECT_ID
FIREBASE_STORAGE_BUCKET
FIREBASE_MESSAGING_SENDER_ID
FIREBASE_APP_ID
```

## 2. Security Rules

Firebase CLI で対象プロジェクトを選択し、リポジトリのルールを反映します。

```sh
firebase use <project-id>
firebase deploy --only firestore:rules
```

`firestore.rules` は、ログインユーザー本人の `users/{uid}` 配下だけを読み書き可能にします。

## 3. データ構造

```text
users/{uid}/app/state
users/{uid}/items/{itemId}
users/{uid}/drafts/{draftId}
users/{uid}/pushSubscriptions/{endpointHash}
purchaseInbox/{sourceTenant:eventId}
inventoryUnitBindings/{sourceTenant:inventoryUnitId}
purchaseInboxAudits/{auditId}
```

設定類は `app/state`、商品は競合を減らすため1商品1ドキュメント、Web Push購読は端末ごとのドキュメントとして保存します。

下書きも2026-09-12から1下書き1ドキュメントです。それまでは `app/state` の塊に入れていましたが、塊の同期は丸ごと上書きになるため、まだ送信していない下書きが痕跡なく消えました（実際に消えた）。商品と同じく未送信の印・削除の記録・取り込み位置を持たせ、新しいほうが勝つ形にしています。`app/state` の塊から来た下書きは、手元が空のときだけ初期移行として受け入れます。書き手が複数（デスクトップ・モバイル・エージェント）になるのは通常運用なので、単一書き手を前提にしないこと。

Loose Integration の `purchase_confirmed` Inbox と Unit claim は、既存の `users/{uid}` 再帰ルールの影響を避けるため、トップレベルの専用コレクションへ保存します。各ドキュメントに `ownerUid` を保持し、専用ルールでユーザー本人だけが読み書きできます。InboxはPWA側の専用IndexedDBにも保存し、受信・quarantine・duplicate/conflictの履歴を商品ドキュメントや `app/state`へ混在させません。

`inventoryUnitBindings` は作成後の更新・削除を禁止し、Firestore transactionでclaim作成、商品への `inventory_unit_id` / `integration`反映、Inboxの `bound` 化を同一処理で行います。

## 4. Supabase からの切り替え

Firebase Authentication と Supabase Authentication のユーザーIDは一致しません。既存ユーザーはFirebase側で再ログインまたは再登録し、旧端末の「バックアップをダウンロード」で出力したJSONを一度復元してから同期してください。

Supabaseの環境変数とテーブルは、Firebaseでの同期確認後に削除します。
