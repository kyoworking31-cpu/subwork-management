# AI利用枠ウィジェット (iPhone / Scriptable)

Claude と ChatGPT(Codex) の利用枠を iPhone のホーム画面に表示するウィジェットです。

| 項目 | Claude | ChatGPT |
| --- | --- | --- |
| 5時間枠 | `five_hour` | `rate_limit.primary_window` |
| 週間枠 (全体) | `seven_day` | `rate_limit.secondary_window` |
| 週間枠 (モデル別) | `seven_day_opus` / `seven_day_sonnet` など、返ってきたものをすべて表示 | `additional_rate_limits` (例: GPT-5.x-Codex-Spark) |
| クレジット | 追加利用 (`extra_usage`) の使用額 / 月間上限 | Codex クレジット残高 (`credits.balance`) |

- 「残り◯%」で表示します (設定で「使った◯%」にも切替可)。残り 25% 以下で黄色、10% 以下で赤のバーになります。
- リセットまでの残り時間を表示します。
- 取得に失敗した場合は前回のデータを ⚠︎ 付きで表示します。
- ChatGPT 側は **Codex の利用枠** です (chatgpt.com の「Codex → 設定 → 使用状況」と同じデータ)。通常のチャットのメッセージ上限は ChatGPT が公開していないため表示できません。

> ⚠️ どちらも公式 API ではなく、claude.ai / chatgpt.com の Web 画面が内部で使っているエンドポイントを利用しています。仕様変更で動かなくなる可能性があります。

## 1. インストール

1. App Store で **Scriptable** (無料) をインストール
2. Scriptable を開き、右上の「＋」で新しいスクリプトを作成
3. [`AIUsageWidget.js`](./AIUsageWidget.js) の中身をすべてコピーして貼り付け
4. 左上のタイトルを `AI利用枠` などに変更して保存

## 2. 認証情報の設定

Scriptable アプリ内でスクリプトを実行 (▶) すると設定メニューが開きます。
入力した値は iPhone の **Keychain** に保存され、ファイルには残りません。

### Claude

1. PC のブラウザで https://claude.ai にログイン
2. 開発者ツール (F12) → **Application** タブ → Cookies → `https://claude.ai`
3. `sessionKey` の値 (`sk-ant-sid01-…`) をコピー
4. メニュー「Claude の Cookie を設定」に貼り付け

### ChatGPT

1. PC のブラウザで https://chatgpt.com にログイン
2. 開発者ツール → **Application** → Cookies → `https://chatgpt.com`
3. `__Secure-next-auth.session-token` の値をコピーして、メニュー「ChatGPT の Cookie を設定」に貼り付け
   - `…session-token.0` / `.1` のように分割されている場合は、**Network** タブで chatgpt.com へのリクエストを選び、リクエストヘッダー `cookie:` の値全体を貼り付けてください
4. うまくいかない場合の代替: https://chatgpt.com/api/auth/session を開き、`accessToken` の値を「ChatGPT のアクセストークンを設定」に貼り付け (約10日で期限切れになるので、その都度再設定が必要)

PC と iPhone を Apple の「ユニバーサルクリップボード」で連携しておくと、コピー＆ペーストが楽です。

### 接続テスト

メニュー「接続テスト」で両方 ✓ になれば OK です。「プレビュー」で見た目を確認できます。

## 3. ウィジェットを置く

1. ホーム画面を長押し → 左上「編集」→「ウィジェットを追加」→ **Scriptable**
2. サイズを選んで追加 (おすすめは **中** または **大**)
3. 追加したウィジェットを長押し →「ウィジェットを編集」→ Script で `AI利用枠` を選択

| サイズ | 表示内容 |
| --- | --- |
| 小 | 縦並び。各サービスの 5時間枠・週間枠のみ |
| 中 | 左右2列。各サービス 3行 (5時間・週間 + 使用率が一番高いモデル別枠) + クレジット |
| 大 | 縦並び。すべての枠 + リセットまでの時間 + クレジット |

ウィジェットの **Parameter** に `demo` と入れると、ダミーデータで見た目を確認できます。

## 設定の変更

スクリプト先頭の `CONFIG` で変更できます。

- `showRemaining`: `true` で「残り◯%」(既定)、`false` で「使った◯%」を表示
- `refreshMinutes`: 更新間隔 (既定 15分。実際の更新タイミングは iOS が決めます)
- `claudeCreditsInCents`: Claude の追加利用額がセント単位で返る場合 `true` (既定)。金額が 100 倍/100 分の1 に見える場合は切り替えてください
- `colors`: 色

## トラブルシューティング

| 表示 | 対処 |
| --- | --- |
| `認証エラー(401/403)` | Cookie の期限切れ・ログアウト。もう一度 Cookie を取得して設定 |
| `Cloudflareにブロックされました` | 時間を置いて再試行。続く場合は Wi-Fi/モバイル回線を切り替える |
| `未設定` | アプリ内で実行して Cookie を設定 |
| ⚠︎ と時刻 | 最新の取得に失敗し、その時刻のキャッシュを表示中 |

## セキュリティ上の注意

- `sessionKey` / `session-token` は **ログイン状態そのもの** です。他人に渡したり、スクリプトに直接書き込んで共有したりしないでください。
- 送信先は `claude.ai` と `chatgpt.com` のみです。
- 不要になったらメニューの「保存した認証情報をすべて削除」で Keychain から削除できます。ブラウザでログアウトすると Cookie も無効になります。
