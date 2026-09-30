# アプリのバージョン情報を管理・表示する

- 関連Issue: #9
- 調査日: 2026-09-30

## 目的・背景

現状、アプリのバージョン情報を管理・表示する仕組みがない。本アプリはGitHub Pagesへ
`main`へのpush毎に自動デプロイされる単一ページアプリ（`vite-plugin-singlefile`で1ファイルに
インライン化）であり、GitHubのRelease機能やタグ付きリリースは運用していない。この構成で
「どのバージョンで発生した問題か」を追跡できるようにする最小構成を検討する。

## 調査内容

- `package.json`には`"version": "0.1.0"`が既に存在する（`npm init`時のデフォルトのまま未運用）。
- Viteは`define`ビルドオプションでビルド時に任意のグローバル定数をコード中の識別子に置換できる
  （`vite.config.ts`の`define: { __APP_VERSION__: JSON.stringify(pkg.version) }`）。
  `import.meta.env`経由でも環境変数は埋め込めるが、`package.json`の値をVite設定ファイル内で
  `readFileSync`して読み込み、独自グローバル定数として`define`する方が依存が少なく単純。
- `.github/workflows/deploy-pages.yml`はタグ付けやバージョンアップ処理を一切行っておらず、
  `main`へのマージごとに`vite build`した`dist/`をそのまま公開している。Gitタグやリリースノート
  生成の仕組みは存在しない（本Issueのスコープ外として明記されている）。
- `package.json`の`version`は人手更新のため、機能追加のたびに値を上げ忘れると「どのビルドか」を
  区別できない。ユーザーから「いつのバージョンか簡易に識別したい」という要望があり、`version`に
  加えて**ビルドを一意に識別する情報**と**ビルド年月日**も表示する。
  - ビルド識別子: 当初`git rev-list --count HEAD`（総コミット数、Androidの`versionCode`と同様の
    考え方）を検討したが、次の理由でより一般的な**Gitショートコミットハッシュ**
    （`git rev-parse --short HEAD`）を採用する。
    - セマンティックバージョン＋Gitショートハッシュ＋ビルド日時の組み合わせは、VS Code本体の
      「バージョン情報」ダイアログ（Version / Commit / Date）やDockerイメージタグ等、
      Web/デスクトップアプリで広く使われている一般的な表記慣習である。
    - コミット総数は`actions/checkout@v4`の既定`fetch-depth: 1`（浅いクローン）では取得できず、
      CI側の設定変更（`fetch-depth: 0`）が別途必要になる。一方`git rev-parse --short HEAD`は
      `HEAD`コミットオブジェクト自体があれば取得できるため、浅いクローンでも追加設定なしで
      正しく動作する。
    - コミット総数はリベース・スカッシュ等の運用で意味が揺れやすいが、コミットハッシュは
      対象コミットを一意に特定できる。
  - ビルド年月日: `vite.config.ts`評価時（＝`vite build`実行時）の`new Date()`を`YYYY-MM-DD`形式に
    整形して埋め込む。
  - どちらもローカル開発ビルド（`npm run dev` / `npm run build`）時はワーキングツリーの状態から
    そのまま取得できる。gitが使えない環境（tar展開のみ等）向けに、コマンド失敗時は
    ビルド識別子`'unknown'`にフォールバックする。
- 画面表示先の候補:
  - サイドパネル上部のアプリタイトル（`main.ts`の`el('h1', { text: '点群ビューア' })`）: 常時表示され、
    デバッグ情報パネルのように操作（トグル）不要で確認できる。
  - デバッグ情報パネル（`Viewer.getDebugInfo()` / `#debug`）: Issue #5/#7で追加した、カメラ・
    OrbitControls内部状態の調査用パネル。バージョンはカメラ制御と無関係な関心事のため、
    `ViewerDebugInfo`（`Viewer.ts`）に混ぜるのは責務の観点で不適切。

## 調査結果

- `package.json`の`version`フィールドをビルド時にVite `define`で埋め込む方式が最小構成で実現できる。
- 表示先は、常時参照可能なサイドパネルのアプリタイトル横が適切。デバッグ情報パネルはカメラ制御の
  内部状態専用として役割を分離する。
- バージョン表記ルールは、セマンティックバージョニング（[semver.org](https://semver.org/lang/ja/)）を
  採用し、`package.json`の`version`を単一の情報源とする。GitHubのタグ・Release機能とは連携せず
  （スコープ外）、機能追加・修正のたびに人手で`package.json`の`version`をインクリメントする運用とする
  （破壊的変更: メジャー、機能追加: マイナー、バグ修正: パッチ）。

## 結論・採用方針

- `vite.config.ts`で`package.json`を読み込み、以下3つのグローバル定数を`define`でビルド時に埋め込む。
  - `__APP_VERSION__`: `package.json`の`version`。
  - `__BUILD_HASH__`: `git rev-parse --short HEAD`（取得失敗時は`'unknown'`にフォールバック）。
  - `__BUILD_DATE__`: ビルド実行時刻を`YYYY-MM-DD`に整形した文字列。
- `src/vite-env.d.ts`に3定数の`declare const`を追加し型を通す。
- 表示用の文字列整形は`formatVersionLabel(version, buildHash, buildDate)`として`src/ui.ts`に
  純粋関数として切り出し、TDDでユニットテストする（例: `v0.1.0 (a1b2c3d, 2026-09-30)`）。
- `src/main.ts`のサイドパネルタイトル（`<h1>点群ビューア</h1>`）の横に、上記関数の戻り値を
  small文字で常時表示する（デバッグ情報パネルのトグル操作なしで確認できる）。
- Gitショートハッシュは浅いクローンでも取得できるため、`.github/workflows/deploy-pages.yml`の
  `checkout`設定変更は不要。
- バージョン表記ルール（セマンティックバージョニングを採用し`package.json`を単一の情報源とする）を
  `CONTRIBUTING.md`に明記する。
- 反映先: [docs/detailed-design.md](../detailed-design.md)「8. バージョン情報の管理・表示」（新設）。

## 参考資料

- [Vite: Build Options - define](https://vitejs.dev/config/shared-options.html#define)
- [セマンティック バージョニング 2.0.0](https://semver.org/lang/ja/)
- [actions/checkout: fetch-depth](https://github.com/actions/checkout#usage)
