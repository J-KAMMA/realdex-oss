#!/usr/bin/env node
/** Single-source Markdown rendering of the canonical plan; never changes execution policy. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath}from'node:url';import{inspectRoadmap}from'./roadmap.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const esc=s=>String(s).replaceAll('|','\\|').replaceAll('\n',' ');
export function renderRoadmap(plan){const r=inspectRoadmap(plan),labels={planned:'未実装／未完了',in_progress:'開発・検証中',implemented_local:'限定範囲のローカル実装済み',externally_verified:'対象範囲の外部検証済み'};
 const lines=['# RealDEX 完成・本番公開ロードマップ',`\n正本: ${plan.revision} / 2026-09-06`,`\n親ZIP: \`${plan.baseline.archive}\``,`SHA-256: \`${plan.baseline.sha256}\``,
 '\n## 目的と固定した境界',plan.scope.firstProduction,plan.scope.expansion,plan.scope.ownInfrastructure,
 '現物資産、チェーン間の到着資産、デリバティブの建玉は別の成果物として扱う。通常送金・交換・ブリッジ・先物のAI権限も分離する。',
 '\n## 今回の整理',
 `親ソースを ${plan.baseline.archive} のSHA-256で固定し、Gitのmainを統合基点にする。実装は別worktreeで行い、統合コミットでも再試験する。完了範囲と残件を分け、別ブランチや旧ZIPの成功を流用しない。` ,
 '開発に着手する依存関係と、本番公開に必要なreleaseRequiresを分離する。例えば正式ビルド環境が取得できなくても、隔離した読み取りアダプターの開発・模擬HTTP試験は進められる。本番承認は迂回しない。',
 '計画のstateは証明書ではない。implemented_localも本番・実チェーン・監査の合格を意味しない。Bitcoin共同承認v0.21 WIPは別保存のまま、未検証の機能として本流へ昇格させない。',
 '\n## 直近の実装順',
 '1. v0.25の市場・板読み取りを保持し、v0.26でGit管理・並行試験・Injectiveの未署名注文/取消しを追加した。リモート作成・pushは未実行。',
 '2. Injectiveの市場・subaccount・注文状態モデル、署名域、取消し／部分約定／出金の検証を一つの縦の実装経路で進める。単なる候補追加へ戻らない。',
 '3. HyperCoreの注文・残高・HyperEVMとの資産対応。その後Chainflip→THORChain→Jupiterの順に送受・回収を検証する。',
 '正式環境のBUILD-01/02とIBC中継の長時間・復旧検証は並行して進める。接続優先順位は見積り採用順位ではない。',
 '\n## 12候補と実装項目', '|順位|候補|担当タスク|初期の役割|','|---:|---|---|---|'];
 for(const c of r.externalCandidates)lines.push(`|${c.priority}|${esc(c.name)}|${c.task}|${esc(c.roles.join(', '))}|`);
 lines.push('\nCCTPは既存のBR-CCTPへ統合する。Atomic Swap・Intent・Canonical Bridgeは方式の集合なので、具体的実装と対応ペアを決めてから実行対応へ昇格する。外部プロトコルのVault・署名者・API・更新権限への依存は隠さない。',
 '\n## フェーズと完了条件','|段階|対象|通過条件|','|---|---|---|',
 '|A|版管理・正式ビルド|同一ソースを固定ランタイム・lockfile・正式コンパイラで再現|',
 '|B|IBC/CCTP等のブリッジ|受取・ACK・期限切れ・返金・停止復旧を対応する実環境で検証|',
 '|C|現物流動性・経路|正確な資産ID、部分約定、費用、最低受取、出金を照合|',
 '|D|鍵・回復・スマート口座|権限制御の強制場所、鍵紛失、取消し、古いバックアップを検証|',
 '|E|非EVM・秘密資産|資産ごとの署名・実行・状態確認・復旧の証拠|',
 '|F|個人PCネットワーク|複数物理PCと異なる回線で参加・離脱・NAT・悪意ある相手を検証|',
 '|G|限定本番|公開テストネット・長時間運用・独立監査・事故対応・配布署名|',
 '|H|上位100位の実用範囲|独自チェーン/発行先トークン別の受取・送金・交換・復旧を実証|',
 '\n## 全タスク（正本JSONから生成）','|ID|状態|着手の前提|公開前の追加条件|','|---|---|---|---|');
 for(const t of plan.tasks)lines.push(`|${t.id}|${labels[t.state]}|${t.dependsOn.join(', ')||'なし'}|${(t.releaseRequires??[]).join(', ')||'各acceptanceと共通公開ゲート'}|`);
 for(const t of plan.tasks){lines.push(`\n### ${t.id} — ${t.title}`,`状態: ${labels[t.state]} / ${t.priority}`);if(t.delivered?.length)lines.push('引継ぎ・今回の実装: '+t.delivered.join(' / '));lines.push('完了条件: '+t.acceptance.join('。')+'。');if(t.remaining)lines.push('残件: '+t.remaining);}
 lines.push('\n## 合否と公開ポリシー','本番利用判定はfalse。今回の計画・模擬HTTP・インメモリ画面試験だけで、資金移転・注文・AIの新権限・本番デプロイを許可しない。','試験結果は実行した範囲ごとに記録し、過去の試験や別ブランチの成功を今回の件数へ足さない。完成までの日付や一律の高速化・全資産の移転可能性は保証しない。','\n再生成: `node app/render-roadmap.mjs`。依存関係確認: `node app/roadmap.mjs`。');return lines.join('\n')+'\n';}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(renderRoadmap(JSON.parse(fs.readFileSync(path.join(root,'plans/DEVELOPMENT-ROADMAP-2026-09-06.json'),'utf8'))));
