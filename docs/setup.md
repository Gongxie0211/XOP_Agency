# 立ち上げの手順（施工完了のLINE報告）

全部で7つの手順です。手順1〜3はアカウントを作ってボタンを押す作業、手順4〜5はパソコンでコマンドを打つ作業です。
画面の名前やボタンの位置は変わることがあるので、見当たらないときは近い名前のものを探してください。

用意するもの：会社のメールアドレス、LINEのビジネスアカウント、Supabase のアカウント、Cloudflare のアカウント（xop-field.pages.dev と同じもの）

---

## 1. Supabase（データベース）を用意する

1. https://supabase.com で新しいプロジェクトを作る。**Region は Tokyo（Northeast Asia）**。プランは Pro（決定済み）。
2. 左のメニューの **SQL Editor** を開き、`supabase/migrations/20261027000000_line_report.sql` の中身を全部はりつけて **Run**。
3. **Project Settings → API** にある **Project URL** を控える（例：`https://abcd1234.supabase.co`）。

## 2. LINE公式アカウントと Messaging API を用意する

1. LINE Official Account Manager（https://manager.line.biz）で、**クラックス合同会社**の名前で公式アカウントを作る。
2. 設定 → **Messaging API** → 「Messaging APIを利用する」。プロバイダーは新しく「クラックス合同会社」を作る。
3. LINE Developers（https://developers.line.biz/console/）でそのチャネルを開き、**Messaging API設定 → チャネルアクセストークン（長期）** を発行して控える。
4. 応答メッセージ・あいさつメッセージは、Official Account Manager の方で好きな文にしてかまいません（このしくみはプッシュメッセージを送るだけで、Webhookは使いません）。

> 料金：公式アカウントは無料プランで始められますが、送れるメッセージの数に月ごとの上限があります。報告1件で「受付」「OK」「証明書」と本部への知らせで4〜5通ほど使います。試験の規模（5〜10現場）なら収まる見込みですが、始める時点の料金表で確認してください。

## 3. LINEログインと LIFF（LINEの中で開く画面）を用意する

1. LINE Developers で、**手順2と同じプロバイダー**の中に **LINEログイン** チャネルを作る（アプリタイプは「ウェブアプリ」）。
2. チャネル基本設定の **チャネルID** を控える。
3. 「リンクされたLINE公式アカウント」に手順2の公式アカウントを選ぶ。
4. **LIFF** タブ → 追加
   - サイズ：**Full**
   - エンドポイントURL：手順5で決める画面の置き場所（例：`https://xop-report.pages.dev/`）。あとで直せます。
   - Scope：**openid** と **profile** にチェック
   - 友だち追加オプション：**On (Aggressive)**（まだ友だちでない人に、公式アカウントの友だち追加をすすめる）
5. できた **LIFF ID**（例：`2001234567-AbCdEfGh`）を控える。報告画面のURLは `https://liff.line.me/LIFF ID` になります。
6. 試験中はチャネルを「開発中」のままにして、使う人を「テスター」に登録する方法もあります。全員に開くときは「公開」にします。

## 4. サーバー側の処理（Edge Function）を置く

パソコンに Supabase CLI を入れて、このリポジトリのフォルダで次を実行します。

```
supabase login
supabase link --project-ref （Project URL の https:// と .supabase.co の間の文字）

supabase secrets set \
  LINE_LOGIN_CHANNEL_ID=（手順3-2のチャネルID） \
  LINE_MESSAGING_TOKEN=（手順2-3のチャネルアクセストークン） \
  APP_URL=https://liff.line.me/（手順3-5のLIFF ID） \
  ALLOWED_ORIGIN=https://xop-report.pages.dev

supabase functions deploy api --no-verify-jwt
```

`--no-verify-jwt` は、Supabase のログインではなく LINE のログインで本人を確かめるために付けます（処理の中で毎回 LINE に確認しています）。

## 5. 画面を置く

1. `web/config.js` を書きかえる。

   ```js
   window.XOP_CONFIG = {
     liffId: "2001234567-AbCdEfGh",
     apiUrl: "https://abcd1234.supabase.co/functions/v1/api",
   };
   ```

2. `web` フォルダを Cloudflare Pages に置く（Workers & Pages → 作成 → Pages → 「ファイルをアップロード」で `web` フォルダを選ぶ）。名前を `xop-report` にすると `https://xop-report.pages.dev/` になります。
3. 手順3-4の LIFF のエンドポイントURLと、手順4の `ALLOWED_ORIGIN` を、この場所に合わせる。

## 6. 最初の本部の人を登録する

Supabase の SQL Editor で、次を実行します（名前と招待コードは好きなものに）。

```sql
insert into members (name, role, invite_code) values ('本部 担当', 'hq', 'HQ2026');
```

スマホのLINEで `https://liff.line.me/（LIFF ID）` を開き、招待コード `HQ2026` を入れます。
これで本部の画面 `https://liff.line.me/（LIFF ID）/hq.html` が使えます（パソコンのブラウザで開くと、LINEのログイン画面が出ます）。

そのあとは、本部の画面の「代理店・メンバー」から代理店と施工責任者を登録し、出てきた招待コードを本人にLINEで送ってください。

## 7. 公式アカウントのメニューを作る

LINE Official Account Manager → **リッチメニュー** → 作成

- テンプレートは3つに分かれたものを選ぶ
- A（一番目立つ所）：「施工完了報告」→ リンク `https://liff.line.me/（LIFF ID）`
- B：「現場の一覧」→ 同じリンク
- C：「手順・動画」→ 写真の撮り方などの説明ページ（あとで用意）

---

## 現場QRについて

本部の画面の「現場の登録」に出る「報告用のリンク」（`https://liff.line.me/（LIFF ID）?site=T-0012`）をQRコードにすると、読み取ったときにその現場の報告画面が直接開きます。

## 試験運用版でまだやっていないこと

- 施工後の写真を撮るとき、施工前の写真をカメラ画面にうっすら重ねる機能（仕様書 P-4）
- AIによる写真のチェック（C-3）、施工予定日を過ぎたときのお知らせ（L-5）
- 正規施工証明書の自動作成（試験中は本部がひな形 B-4 で作り、画面で「発行した」を押す）
- 本部の画面の二段階認証（今は LINE のログインだけ。LINE アカウント側の設定に頼る）
- 日当の金額計算（出面の一覧を表計算に書き出して本部で計算）
