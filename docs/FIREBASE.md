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
users/{uid}/pushSubscriptions/{endpointHash}
```

設定類は `app/state`、商品は競合を減らすため1商品1ドキュメント、Web Push購読は端末ごとのドキュメントとして保存します。

## 4. Supabase からの切り替え

Firebase Authentication と Supabase Authentication のユーザーIDは一致しません。既存ユーザーはFirebase側で再ログインまたは再登録し、旧端末の「バックアップをダウンロード」で出力したJSONを一度復元してから同期してください。

Supabaseの環境変数とテーブルは、Firebaseでの同期確認後に削除します。
