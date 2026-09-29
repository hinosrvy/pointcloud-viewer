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
- マウス左ドラッグでの視点回転を、クリックした点を中心に回転するよう変更（Issue #3）。
  `OrbitControls.target`をクリック位置へ差し替える方式は`update()`の`lookAt(target)`により
  その点が画面中央へ強制的にスナップしてしまう構造的な制約があるため採用せず、
  ドラッグ確定時にクリック位置を回転中心として記録し、`OrbitControls`を介さずカメラの位置と
  向きを同時に回転させる独自実装（`Viewer.rotateAroundPivot()`）に置き換えた。単純クリックでは
  視点は変化せず、ドラッグ終了時も視点ジャンプなく通常の`OrbitControls`操作へ復帰する。
  設計は docs/detailed-design.md「3.7.3 視点制御」、調査は docs/research/3-rotate-around-cursor.md を参照。
- マウスホイールでのズームイン操作を繰り返すとズームインが効かなくなる不具合を修正（Issue #5）。
  `OrbitControls`のカーソル位置中心ズームはカメラの現在距離に比例した絶対移動量でカメラを
  動かすため、`controls.minDistance`が既定値`0`のままだと距離が十分小さくなった時点で
  移動量が倍精度浮動小数点の丸め誤差を下回り、ズームインが反応しなくなる。これを防ぐため
  `controls.minDistance`にシーンサイズに応じた正の下限値（`minDistanceForSize()`）を設定した。
  また、クリック位置中心の回転（Issue #3）終了時に`target`を置き直す処理で、`target`が
  カメラ位置とほぼ一致してしまうことがあり、その場合`OrbitControls`のズーム・パンが
  距離に比例した移動量計算のため無反応になる不具合も併せて修正（`computeTargetAfterRotate()`
  で置き直し距離を`minDistance`未満にならないようクランプ）。
  実機確認の結果、`minDistance`を`camera.near`と同じ比率（`size / 5000`）にすると通常操作の
  数回のホイール操作だけで下限に到達し、ズームだけでなく`OrbitControls`のパン感度
  （距離に比例）も潰れて右ドラッグ移動まで無反応になることが判明したため、`minDistanceForSize()`を
  `camera.near`から切り離し、実用上到達しない程度に小さい比率（`size * 1e-6`）に修正した。
  この切り分けのため、カメラ位置・`target`・距離・`minDistance`等を画面表示するデバッグ情報
  パネル（ツールバー「デバッグ情報」ボタン）を追加した。
  設計は docs/detailed-design.md「3.7.3 視点制御」、調査は docs/research/5-zoom-in-stuck.md を参照。
- 広範囲の点群でズームインを繰り返すと、途中でズームイン・パン・ダブルクリックズームの
  いずれの操作もできなくなる不具合を修正（Issue #7）。
  `camera.near`をシーン全体のバウンディングボックス基準の固定値にしていたため、広範囲点群では
  ズームインで近づいた点がニアクリップ面より手前に来て見えなくなっていた問題を、カメラ・`target`間
  距離に応じて`near`を毎フレーム再計算する`dynamicNear()`で解消した。また、ホイールズームの
  1回あたりの歩幅が急激すぎる問題を`zoomSpeed`引き下げで緩和した。
  さらに、ズームを繰り返すと`camera.position`・`controls.target`間の距離が`minDistance`を
  大きく下回り、以降の操作が無反応になる不具合を確認し、`render()`内で毎フレーム距離を
  再チェックし`minDistance`未満なら同じ方向を保ったまま押し戻す防御的なクランプ
  （`clampCameraDistance()`）を追加した。
  ダブルクリックでの点群ズームは、クリック地点を画面中央へ移動させる実装が
  `OrbitControls.update()`の`camera.lookAt(target)`により視点を不自然にスナップさせていたため、
  視線方向（`camera.getWorldDirection()`）を変えずにその方向へカメラを前進させる方式に変更し、
  `easeOutCubic()`による約300msの滑らかなアニメーションを追加した。
  検討の過程でシングルクリックでも`controls.target`をクリック地点へ更新する実装を一時採用したが、
  同じ理由で画面中央へのスナップが発生しダブルクリック操作と干渉したため撤回し、
  単純クリックは`onPick`コールバックの発火のみとした。
  設計は docs/detailed-design.md「3.7.3 視点制御」、調査は docs/research/7-zoom-in-stuck-wide-scale.md を参照。
