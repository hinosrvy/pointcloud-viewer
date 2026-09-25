# GitHub Pages への GitHub Actions 自動デプロイ方式

- 関連Issue: #1
- 調査日: 2026-09-25

## 目的・背景

`npm run build` で生成される `dist/index.html`（単一ファイル）を GitHub Pages で公開したい。
[docs/basic-design.md](../basic-design.md) 2.3節で「`main`ブランチの`/docs`を公開元にしない
（設計書フォルダ`docs/`と衝突するため）、GitHub Actionsでデプロイする」と決定済み。
その具体的な実装方式を検証する。

## 調査内容

GitHub PagesへActionsからデプロイする方式を2つ比較した。

1. **公式Actions方式**（`actions/configure-pages` + `actions/upload-pages-artifact` + `actions/deploy-pages`）
   - GitHubが公式提供。リポジトリ設定の Pages Source を **「GitHub Actions」** にする。
   - ブランチやフォルダ（`gh-pages`ブランチ、`/docs`等）を一切使わない。ビルド成果物をartifactとして
     アップロードし、Pages APIで直接デプロイする。
   - ワークフローに `permissions: pages: write, id-token: write` と
     `environment: github-pages` の設定が必要。
2. **サードパーティAction方式**（`peaceiris/actions-gh-pages` 等で`gh-pages`ブランチにpush）
   - Pages SourceはRepository設定で「`gh-pages`ブランチ」を指定する必要がある。
   - サードパーティActionへの依存が増える。

`vite.config.ts` は既に `base: './'`（相対パス）でビルドされ、`vite-plugin-singlefile`で
JS/WASM/Workerを`dist/index.html`単体に内包しているため、GitHub Pagesのプロジェクトサブパス
（`https://<user>.github.io/<repo>/`）でも追加設定なしで動作する見込み。

Node.jsバージョン: `vite@^7.3.6` は Node 20.19+ / 22.12+ を要求するため、ワークフローの
`actions/setup-node`は `node-version: 22` を指定する。

## 調査結果

- 公式Actions方式は、ブランチ／フォルダの公開元を一切使わないため、
  設計書フォルダ`docs/`との衝突が構造的に発生しない（Issue #1の懸念を完全に解消）。
- サードパーティAction方式は`gh-pages`ブランチを使うため衝突はしないが、
  余分な依存が増える分、公式方式より劣る。

## 結論・採用方針

**公式Actions方式**（`actions/configure-pages` + `actions/upload-pages-artifact` +
`actions/deploy-pages`）を採用する。

- トリガー: `main`へのpush（`workflow_dispatch`による手動実行も可）。
- ジョブ: `npm ci` → `npm run build`（`tsc --noEmit && vite build`）→ `dist/`をartifact化 → デプロイ。
- リポジトリ側の設定変更（Settings > Pages > Source を「GitHub Actions」にする）が別途必要
  （Actionsのワークフローファイルだけでは有効化されない。マージ後に承認者が設定する）。
- 反映先: [docs/detailed-design.md](../detailed-design.md) に配信・デプロイ構成として追記。

## 参考資料

- https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
- https://github.com/actions/deploy-pages
- https://github.com/actions/upload-pages-artifact
- https://vite.dev/guide/build.html#public-base-path
