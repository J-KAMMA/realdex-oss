# RealDEX v0.26 — GitHub・並行開発の開始手順

## 到達点

v0.25のソースを親にGit履歴を作成し、三つの作業ブランチを統合しました。
GitHub上の作成・push・PR・CI実行・ブランチ保護は、このセッションでは未実行です。
GitHub接続は読み取り操作のみで、ローカルの認証済みgh CLIもありません。
複数AIの自律起動を行ったという意味でもありません。

未監査の開発版です。実資産の鍵を使わず、署名・ネットワーク制限を解除しないでください。

## 1. 履歴を含むソースを復元

Git bundleを保存したフォルダーで次を実行します。Gitが必要です。

```sh
git clone RealDEX-v0.26-2026-09-06.bundle RealDEX
cd RealDEX
```

ZIPにあるソースを`git init`し直すのではなく、この方法で既存履歴を維持できます。
main、baseline/v0.25、統合済みdev/platform・dev/runtime・dev/ordersの履歴を含みます。
生成ログと秘密状態はGitへ含めず、旧検証記録は配布ソースZIPに保持しています。

## 2-3. （公開版では省略）

非公開リポジトリへの反映手順と内部の作業場所分離手順は、公開版には含めていません。

## 4. 同時実行するソース試験

```sh
node app/ci.mjs --suite all --jobs 3 --output ci-output
```

wallet、node、external、app、relayの5群を最大3同時で実行します。
既存出力ディレクトリは上書きしないため、再実行時は別の名前を指定します。
タイムアウト、中止、空試験、ログ上限超過、ソース変化は合格にしません。
各ログと実行時刻・ソースhash・実行コミットを記録します。
GitHubでは同じ5群をmatrixで実行する定義を追加しましたが、このセッションでは実行していません。

これは全体Reactビルド、実VM、実ブラウザ、公開テストネット、監査の代わりではありません。
全体検証は従来どおり `node app/verify.mjs --full --output acceptance-full` です。
不足する依存はblockedとなり、本番判定はfalseです。

## 5. 今回の実装を動かす

```sh
node app/cli.mjs start
node node/spot-order.mjs
```

二つ目は合成データによるInjective注文・取消しの未署名データ生成例です。
数量・価格刻み、最低注文額、subaccount、18桁追加スケールを検査します。
署名・注文送信・取消し実行・公開APIの適合確認は行いません。
GTC注文の有効期限と、手元の見積り期限を混同しないよう分離しています。

## 資料

- Git worktree: https://git-scm.com/docs/git-worktree
- Git bundle: https://git-scm.com/docs/git-bundle
- gh repo create: https://cli.github.com/manual/gh_repo_create
- GitHub matrix: https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations
