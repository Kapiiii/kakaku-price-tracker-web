# PRICE NOTE｜価格追跡・見積もり管理

GitHub Pages +
Supabaseで動く、個人別の価格.com価格追跡アプリです。利用時に自分のPCでサーバーを起動する必要はありません。

サイトのURL：<https://kapiiii.github.io/kakaku-price-tracker-web/>

## このプロジェクトで最初に行う設定

データベースと `tracker-api` は反映済みです。以下のWeb公開・GitHubログインの設定を行います。

### 1. GitHub Pagesを有効にする

[リポジトリのPages設定](https://github.com/Kapiiii/kakaku-price-tracker-web/settings/pages)で次を選択して
**Save** します。

- Source：**Deploy from a branch**
- Branch：**main**
- Folder：**/docs**

公開まで数分かかる場合があります。上記サイトURLでログイン画面が表示されれば完了です。「デモを見てみる」はログイン設定前でも利用できます。

### 2. GitHub OAuth Appを作成する

[GitHubのOAuth Apps設定](https://github.com/settings/developers)から **New OAuth App**
を開き、次を入力します。

| 項目                       | 入力値                                                      |
| -------------------------- | ----------------------------------------------------------- |
| Application name           | PRICE NOTE                                                  |
| Homepage URL               | `https://kapiiii.github.io/kakaku-price-tracker-web/`       |
| Application description    | 個人用の価格追跡・見積もり管理                              |
| Authorization callback URL | `https://nicgbsemqltpxyvyoslk.supabase.co/auth/v1/callback` |
| Enable Device Flow         | OFFのまま                                                   |

**Register application** 後、**Client ID**を控え、**Generate a new client
secret**で秘密鍵を発行します。秘密鍵は次のSupabase画面に直接入力してください。チャット・GitHub・画面のソースコードには載せません。

### 3. SupabaseのGitHubログインと戻り先を設定する

[Supabaseプロジェクト](https://supabase.com/dashboard/project/nicgbsemqltpxyvyoslk)の **Authentication → Sign
In / Providers → GitHub** を開きます。

- Enable Sign in with GitHub：ON
- Client ID：手順2のClient ID
- Client Secret：手順2で発行した秘密鍵
- Save

続いて **Authentication → URL Configuration** を設定します。

- Site URL：`https://kapiiii.github.io/kakaku-price-tracker-web/`
- Redirect URLs：同じURLを追加してSave

サイトを開き直し、**GitHubでログイン**します。友人などもそれぞれのGitHubアカウントでログインできます。登録商品・価格履歴は本人のアカウントに保存されます。

公式手順：[GitHubログインの設定](https://supabase.com/docs/guides/auth/social-sign-in/auth-github)、[GitHub Pagesの公開元](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。

## 機能と計算方法

- 商品URLの複数登録・削除。毎日1回の自動更新と、ボタンによる手動更新に対応します。
- 商品名・画像・店舗別価格を最大20ショップ取得・保持。販売店が少ない場合は取得できた件数を保存します。
- **指定時点 / 現在 / 指定ショップ除外後**の3つの価格・総額を並べて比較します。
- 「指定時点の総額」の隣にあるプルダウンは、先頭の「初回登録時点」が初期値です。その下から保存日時を選ぶと総額・商品価格・差額が連動します。選択はアカウントごとに保存し、次回訪問時や価格更新後も復元します。
- 除外ショップは複数選択。画面と総額を即時再計算し、設定も保存します。
- 取得できなかった商品は**最後に成功した価格**を引き継ぎ、取得日時とエラーを表示します。
- 初回登録時に価格がなければ初回価格は未取得のままです。過去の記録に未来の価格を埋めません。
- 未取得を0円として扱わず、取得済みの商品の合算を**小計**と表示します。
- 差額は両方の時点に価格がある同じ商品だけで計算し、対象件数を表示します。
- 総額推移グラフ・履歴表・時点ごとの内訳。当時の商品構成 / 現在の登録商品での比較を切り替えられます。
- 商品の追加・削除や取得範囲が変わった前後はグラフをつなぎません。
- 商品ごとの価格履歴・ショップ別価格一覧。CSV・JSONバックアップの保存、ローカル版JSONからの移行。
- アクセス制限がある場合は残りの取得を停止。保存HTMLの読み込みも利用できます。
- 更新は1商品ずつ進め、最後にスナップショットをまとめて保存。途中で画面を閉じても次回アクセス時に再開できます。中止した場合は更新前の状態を保持します。

価格は税込販売価格です。送料・ポイント・会員割引・購入時の在庫変化は総額に含みません。購入前に販売店でご確認ください。価格.comの非公式ツールです。取得元の仕様変更・利用条件・robots.txt・アクセス制限によって自動取得ができない場合があります。アクセス制限の回避は行いません。

## 商品URLリストの共有

画面上部の **「リストを共有」** から、現在登録している商品のURLをまとめて共有できます。

1. 共有する商品にチェックを付けます。初期状態は全商品が選択されています。
2. 必要なら「商品名も含める」をONにします。初期状態の共有内容はURLのみです。
3. **「リストをコピー」** でテキストをコピーするか、**「共有リンクをコピー」**
   で一覧ページへのリンクをコピーします。TXT保存も可能です。

共有リンクは、ログインしていない相手も閲覧できます。リンクを知っている人が選択した商品リストを閲覧するため、表示内容を確認してから送ってください。受け取った人は一覧の「URLリストをコピー」を押し、自分のPRICE
NOTEの「商品を追加」に貼り付けてまとめて登録できます。

共有内容は商品URLと任意の商品名です。共有時点のリストをリンクに保存するため、元の登録商品を後から変更した場合は新しいリンクを作成します。共有ページはサーバーへのデータ保存やログインを必要とせず、URLの
`#` 以降の情報から一覧を復元します。

最大100商品、共有リンクは8,192文字までです。商品名を含めて長くなりすぎた場合は、商品名をOFFにするか、コピー・TXT保存をご利用ください。クリップボードへの書き込みをブラウザーが許可しない場合は、画面の表示欄を選択して手動でコピーできます。

## 毎日1回の自動更新

初期設定は **毎日09:00開始（日本時間）・ON**
です。「設定・データ」で開始時刻（0〜23時）とON/OFFを利用者ごとに変更できます。設定を変えた後は「設定を保存」を押してください。OFFは次回以降の開始を止めます。実行中の更新を止める場合は更新欄の「中止」を押します。

PCやブラウザーを開いておく必要はありません。Supabase
Cronが1分ごとに対象を確認し、価格取得を1商品ずつ進めます。9商品なら約9分が目安です。混雑・通信状況によって開始や完了が遅れることがあります。全商品を処理した時点で「自動更新」のスナップショットと総額をまとめて保存します。

同じ利用者・日本時間の同じ日付では1回だけ開始します。手動更新と重なった場合は完了を待ちます。その日の開始時刻を過ぎてから登録・ONにした場合は、次の定期確認から開始します。中止した自動更新は同じ日に自動でやり直しません。必要なら手動更新できます。

価格取得に失敗した商品は最後に成功した価格を引き継ぎます。アクセス制限が返った場合は残りの商品も停止します。通信中のサーバー停止などで処理自体が中断された場合は、実行権の期限後に続きから再試行します。

画面を開いている間の定期確認では変更番号だけを読み、価格履歴全体は変更があった場合だけ取得して通信量を抑えます。Supabaseの休止・障害・無料枠の制限中は自動更新も停止します。定刻の実行を保証する仕組みではありません。

実装は[Supabase公式の定期実行手順](https://supabase.com/docs/guides/functions/schedule-functions)に沿っています。呼出し専用の秘密鍵はVaultに保存し、ブラウザーやGitHubには公開しません。

## データ構造

| テーブル               | 内容                                                                   | アクセス                                    |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------- |
| `tracker_states`       | `user_id` 主キー、更新競合防止用 `version`、`data` JSONB、`updated_at` | 本人だけ読み取り。書き込みは認証済みAPI経由 |
| `tracker_jobs`         | 利用者別の取得ジョブ、途中結果、実行権の期限、開始日時・状態           | 本人だけ読み取り。APIだけ書き込み           |
| `tracker_request_gate` | 全利用者共通の次回アクセス可能時刻                                     | API専用。ブラウザーからの読み書き禁止       |

`tracker_states.data` の構造：

```json
{
  "schema_version": 1,
  "products": [
    {
      "id": "商品ID",
      "url": "https://kakaku.com/item/K0000000001/",
      "product_key": "K0000000001",
      "name": "商品名",
      "image_url": null,
      "created_at": "2026-11-02T00:00:00Z",
      "archived_at": null,
      "initial_capture_id": "初回の価格取得ID"
    }
  ],
  "captures": [
    {
      "id": "価格取得ID",
      "product_id": "商品ID",
      "name": "商品名",
      "image_url": null,
      "fetched_at": "2026-11-02T00:00:00Z",
      "source": "live",
      "offers": [
        {
          "shop_key": "id:123",
          "shop_name": "店舗名",
          "price": 10000,
          "shop_url": "https://kakaku.com/shop/123/",
          "shipping_text": "無料",
          "stock_text": "在庫あり"
        }
      ]
    }
  ],
  "snapshots": [
    {
      "id": "保存時点ID",
      "started_at": "2026-11-02T00:00:00Z",
      "completed_at": "2026-11-02T00:01:00Z",
      "kind": "update",
      "items": [{ "product_id": "商品ID", "capture_id": "価格取得ID", "status": "fresh", "error": "" }]
    }
  ],
  "excluded": ["id:123"],
  "settings": { "interval": 3, "max_shops": 20, "daily_enabled": true, "daily_hour": 9 }
}
```

成功した価格取得レコードは追記し、各スナップショットはその時点の価格取得IDを参照します。取得失敗時も参照先が残るため、前回成功値で総額を再現できます。削除は
`archived_at` を設定し、過去の内訳を保持します。保存日時はUTC、画面は日本時間です。

RLSで利用者を分離します。管理用RPCは `service_role`
だけ実行可能です。APIは検証済みのログイン情報から本人を特定し、リクエストに書かれた利用者IDは信用しません。`docs/config.js`
のpublishable keyは公開用キーであり、秘密鍵ではありません。

## 無料枠の運用

GitHubの公開リポジトリのPagesと、SupabaseのFreeプランで利用する構成です。有料プラン・有料アドオンへの変更、支払情報の登録はこのコードでは行いません。枠を超えると利用制限や停止が起きる場合があります。Freeのままの利用で、自動的に有料プランへ変更する処理はありません。

- Supabaseのプランは**Freeのまま**にしてください。利用量はDashboardのUsageで確認できます。
- 無操作が続くと無料プロジェクトが休止する場合があります。その場合はDashboardから再開します。
- 現在の登録上限は100商品。1利用者の保存データは最大20MB、読み込みリクエストは22MBです。JSON復元ファイルは21MB以下です。JSONバックアップは容量を抑えるため整形せずに保存します。
- 100商品の一括更新では、商品ごとのAPI呼び出し・robots.txt確認・取得待機のため時間と無料枠を使います。必要なときに更新してください。
- 自動更新はSupabase Cronで実行し、対象があるときだけEdge
  Functionを呼び出します。9商品を1日1回なら月約270回の価格取得呼出しが目安です。定期確認の実行ログだけを7日保持し、商品・価格・総額の履歴は削除しません。GitHub
  Actionsのカスタム実行、Storage、課金APIは使いません。GitHub Pages標準の公開処理はGitHub側で実行されます。
- 履歴が増えたらJSONバックアップを定期保存してください。無料枠は変更されることがあるため、具体的な上限は[Supabase公式](https://supabase.com/pricing)と[GitHub Pages制限](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)を確認してください。

## ソースと開発

```text
docs/                         GitHub Pages公開ファイル
  app.js                      ログイン・画面・操作
  core.js                     データ形式・集計・移行（サーバーと共有）
  sharing.js                  商品URLリストの共有形式・検証
  share.html / share-view.js   ログイン不要の共有リスト画面
  vendor/supabase.js           固定バージョンの公式SDK
  config.js                   公開用接続情報
supabase/migrations/           DB設計と権限設定
supabase/functions/tracker-api 認証・取得・保存API
supabase/functions/tracker-daily 自動更新専用API（Vaultのキーで認証）
supabase/functions/_shared/    商品HTML解析とアクセス制御
tests/                        計算・HTML解析・PostgreSQL/RLSテスト
tools/                        ビルド用スクリプト
```

通常の利用・公開にPythonのインストールは不要です。ソースを修正してSDKやサーバー用の単一ファイルを再生成する場合は[Deno](https://deno.com/)
2.9以降を使用します。

```powershell
deno task check
deno task test
deno task build
```

依存は初回に自動取得されます。バージョンはソースと `deno.lock`
で固定しています。テストはローカルの一時PostgreSQL（PGlite）を使い、本番データは変更しません。

ローカルの画面プレビューだけを行う場合：

```powershell
python -m http.server 8765 --bind 127.0.0.1 --directory docs
```

ブラウザーで `http://127.0.0.1:8765/`
を開きます。デモはログインなしで利用可能です。実アカウントでのローカルOAuthを行う場合は、そのURLをSupabaseのRedirect
URLsに追加し、`config.js` の `siteUrl` をローカル用に変更します。

別のSupabaseプロジェクトへ導入する場合は、次の順で設定します。

1. Data APIをON、自動テーブル公開をOFF、自動RLSをONにする。
2. SQL Editorで `supabase/migrations/` をファイル名順に実行する。
3. Edge Functionsに名前 `tracker-api` で `DEPLOY_FUNCTION.js`
   の内容をデプロイする。JWT検証をONにする。管理用のキーはSupabaseがサーバーに供給する環境変数だけを使う。
4. `docs/config.js` のURL・publishable key・サイトURLを変更し、`handler.ts`
   の許可Originを変更する。サーバー変更後は再ビルド・再デプロイする。
5. PagesとGitHub OAuthを上の手順で設定する。
6. `DEPLOY_DAILY_FUNCTION.js` を `tracker-daily` としてデプロイする。`tracker-api`
   と同様に、プラットフォームのJWT検証はONにする。定期実行専用の秘密鍵も追加検証する。
7. `tools/enable_daily.sql` のエンドポイントを導入先に変更する。`__SUPABASE_LEGACY_ANON_JWT__`
   を同じプロジェクトの旧形式のanonキー（JWT形式、公開用）で置き換えてSQL
   Editorで実行する。これはCronからの標準JWT検証だけに使い、ブラウザーは引き続き新形式のpublishable
   keyを使う。管理用のservice_roleキーは入力しない。Cron・pg_netを有効にし、追加の秘密鍵をVault内で自動生成する。専用の秘密鍵はコピー・公開しない。現在のプロジェクトには設定済み。

## 動作確認

- 4種の総額、初回比・指定時点比、全ショップ除外・部分取得の小計。
- 更新失敗時の前回価格引き継ぎと、過去記録に未来価格を使わないこと。
- JSONバックアップ移行、データ参照の整合性、CSVの数式対策。
- 20店舗抽出・重複除去・文字コード・商品違いHTMLの拒否。
- robots.txt・アクセス間隔・403/429の停止・転送先を自動取得しないこと。
- PostgreSQLによるRLS・匿名アクセス禁止・管理用RPCの権限・他利用者のジョブ操作拒否。
- 更新の途中保存・一括確定・再開・中止・競合の検出。
- 自動更新の日本時間の日付境界・1日1回制限・ON/OFF・時刻変更・手動更新との競合・専用キー検証・価格引き継ぎ。
- 共有リンクのURLのみ出力・任意の商品名・日本語と絵文字・重複除去・上限・不正リンクの拒否。

依存ライブラリのライセンスは `THIRD_PARTY_NOTICES.md`
に収録しています。このリポジトリ自体のライセンスは未指定です。
