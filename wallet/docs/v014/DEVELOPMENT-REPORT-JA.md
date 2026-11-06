# RealDEX v0.14 — 拡張非EVM 実装・検証報告

## 基準

今回の実ファイル `RealDEX-Non-EVM-Wallet-Preview-2026-09-05.zip` を基準にしました。SHA-256: `6cb187cd6e44f8d28d5d0c809e70413d0ffbc3a33f224dbb663c520ce6ae4c02`。過去の同名ZIPや会話中の食い違う試験件数ではなく、今回読み込んだアーカイブを基準にします。

## 実装した5経路

1. SPL classic Token TransferChecked: 明示した既存口座同士の送金。ミント登録、口座発見、型・桁数・所有者・残高・fee・期限・simulationの確認、所有者承認、署名、保存、初回送信、結果照合まで接続しました。Token-2022やwrapped SOLは拒否します。
2. Bitcoin: regtest P2WPKHの自前UTXO入力、相手出力と同じ口座へのお釣り、BIP143/SIGHASH_ALL、DER低S署名、txid/wtxid/vsize/手数料上限、署名済み履歴、UTXO再利用拒否、ファイル出力。ネットワーク送信はありません。
3. Cosmos SDK: 標準圧縮secp256k1とBech32、MsgSend、SIGN_MODE_DIRECT、protobuf SignDoc/TxRaw、accountNumber・sequence・gas・timeout・denom/memoの固定と履歴予約。IBC等の任意メッセージは受け付けません。ネットワーク送信はありません。
4. Stellar: GアドレスのCRC付きStrKey、単一XLM PaymentのXDR、ネットワークpassphraseと時間制限の署名、sequence予約、保全・出力。Standalone限定のオフライン機能です。
5. Aptos: 初期Ed25519認証アドレス、固定EntryFunction `0x1::aptos_account::transfer`、BCS、ドメイン分離署名、tx hash、sequence予約、ガス上限表示。chain ID 4限定のオフライン機能です。

既存のEVM、SOL、ICP署名方式を置換せず、口座は系統ごとに別鍵としました。オフライン記録の読取り時も署名・出力・hash・金額・ネットワーク条件を再検査します。署名済み出力をネットワーク接続なしで検査するCLIも追加しました。

## 実行で分かった不具合

既存のアプリ停止試験で、起動表示の直後にSIGTERMを送るとwriter.lockが残るケースが発生しました。wallet/cliとnode/cliで停止ハンドラーが起動表示の後に登録されていました。順序を入れ替え、ready後の即時abortを6回繰り返す回帰試験も追加しました。成功表示の順序を変更したもので、SIGKILLや電源断の耐性を新しく証明したわけではありません。

## 検証方法

通常の選択Node試験と、外部の実行エンジン、独立した形式照合、画面試験を区別します。

- ウォレット435件、既存ノード等1,171件、アプリ65件: 計1,671件。
- 実Anvilでの既存ネイティブ送金15件、LiteSVMの既存SOL14件、新規SPL16件: 計45件。
- 既存AMM16件: 固定nightly版コンパイラによる補助試験。正式0.8.24の合格ではありません。
- 合計1,732件のNode testケース。上記以外を重複加算しません。
- Python/OpenSSL独立照合: 既存96ケース、新規4系統各12ケースで48ケース。新規はBitcoin witness/BIP143、Cosmos protobuf、Stellar XDR、Aptos BCSを別言語で読み取り、暗号署名をOpenSSLベースで検査します。Bitcoinの公開BIP143ベクトルも別の単体試験で固定しています。
- 画面: 既存非EVM12項目、新規29項目。合成APIによるオフラインDOMで、実ブラウザHTTP/CSP・実署名とは別です。

SPL16試験では、実際のLiteSVM Token Programに署名済みTransferCheckedを処理させ、送受トークン数量、SOL fee、拒否条件、変更されたmint/owner、受取証欠落、応答喪失、重複キー、復元を確認します。RPCの高さ・スロット・finality・genesis等は合成で、2個のURLも1個のVMに接続します。公開validatorや分散合意の試験ではありません。

Bitcoin/Cosmos/Stellar/Aptosの実ノード・実ネットワークでは未実行です。形式・署名を正しく生成できることと、実口座・実流動性・実資産で使えることは別です。

## 起動・依存・本番判定

追加したコードは既存のNode組込み暗号と同梱の署名ライブラリを使い、ルート依存指定を増やしていません。通常のローカルサービスに追加npm installは不要です。LiteSVM、Anvil、診断用コンパイラは試験専用で、アプリZIPに同梱しません。

今回の環境はLinux x86-64 / Node 22.16.0 / Python 3.13です。正規依存を欠くReact全体ビルド、正式0.8.24コンパイラ、実ブラウザHTTPは未達です。ブラウザはローカルHTTPへ接続する段階で管理ポリシーの拒否が返り、オフライン試験へ黙って置換していません。

本番判定、公開デプロイ、実資産送信はfalseです。時価総額上位100位のチェーンがすべて完成したという主張はしません。今回の成果はSPLの実行経路と、4系統の限定オフライン署名です。非EVMスワップ、実ブリッジ、SPL拡張、ICP証明書検証、各チェーンの状態取得と送信、OS鍵保護、独立監査は残っています。

## 一次資料

- Solana TransferChecked: https://solana.com/docs/tokens/basics/transfer-tokens
- Classic Token Program: https://www.solana-program.com/docs/token
- Bitcoin BIP143: https://bips.dev/143/
- Bitcoin BIP173: https://bips.dev/173/
- Cosmos SDK protobuf: https://github.com/cosmos/cosmos-sdk/blob/main/proto/cosmos/tx/v1beta1/tx.proto
- Cosmos SDK encoding: https://docs.cosmos.network/sdk/latest/learn/concepts/encoding
- Stellar XDR: https://github.com/stellar/stellar-xdr/blob/master/Stellar-transaction.x
- Aptos Python SDK: https://github.com/aptos-labs/aptos-python-sdk/blob/main/aptos_sdk/transactions.py

今回の試験結果・実際のZIP再展開後の判定は、別添のJSONとログを参照してください。資料の存在だけを実行成功の証拠にはしていません。
