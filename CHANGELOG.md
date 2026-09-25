# 更新履歴

本ファイルは [CONTRIBUTING.md](CONTRIBUTING.md) の開発フローに従い、変更を記録する。

## Unreleased

- 開発フローにテスト駆動開発（TDD）を導入。実装工程をRed→Green→Refactorのサイクルに変更（CONTRIBUTING.md）。
- テストランナーとしてVitestを追加（`npm run test` / `npm run test:watch`、設定は `vitest.config.ts`）。
- リサーチ・技術検証結果を設計書類として管理する規約を追加（`docs/research/`、CONTRIBUTING.md「3. リサーチ・技術検証」を更新）。
- GitHub Pages公開方式を決定：`main`の`/docs`を公開元にすると設計書フォルダ`docs/`と衝突するため、
  GitHub Actionsで`gh-pages`ブランチ等へデプロイする方式を採用（docs/basic-design.md「2.3 動作環境」に明記）。
- GitHub Pagesへの自動デプロイワークフローを追加（`.github/workflows/deploy-pages.yml`、
  `actions/deploy-pages`による公式Actions方式。`main`へのpush/手動実行でビルド・公開。Issue #1）。
  設計は docs/detailed-design.md「7. デプロイ構成（GitHub Pages）」、調査は docs/research/1-github-pages-deploy.md を参照。
