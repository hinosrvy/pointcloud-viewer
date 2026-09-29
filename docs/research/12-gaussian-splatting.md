# ガウシアンスプラッティング（3DGS）表示の実現方式

- 関連Issue: #12
- 調査日: 2026-09-30

## 目的・背景

写真測量・スキャン由来の 3D Gaussian Splatting（3DGS）データを、LAS/LAZ/COPC 点群と同じビューアで
確認できるようにしたい。本ビューアには次の前提があるため、これらを満たしたまま 3DGS を描画できるかを確認する。

- three.js（r186）の `WebGLRenderer` 上に独自の `THREE.Points` 描画を構築している
- 配布形態は単一 HTML（`vite-plugin-singlefile`）で、`file://` でも起動できること
- 平面直角座標系のような大きな絶対座標を「原点相対＋float32」で扱っている
  （[詳細設計書 3.7.1](../detailed-design.md#371-座標系設計原点相対化)）

## 調査内容

### 1. ライブラリ候補の比較

| 候補 | 状況（2026-09-30 時点） | 評価 |
|---|---|---|
| Spark（`@sparkjsdev/spark`） | v2.2.0（2026-09-11 更新）、MIT、peerDependencies `three >=0.180.0`。World Labs が開発 | three.js の `Object3D` として scene に追加できる。複数スプラットの一括ソート、.ply（圧縮PLY含む）/.spz/.splat/.ksplat/.sog に対応 |
| GaussianSplats3D（`@mkkellogg/gaussian-splats-3d`） | v0.4.7（最終更新 2025-01-25） | 1年半以上更新がない。新規採用には不向き |
| 自前実装 | — | 深度ソート（Worker）、共分散の投影、各種フォーマットのデコードを自作する必要があり、工数が大きい |

### 2. 単一 HTML 化の可否（Spark の内部構造）

`node_modules/@sparkjsdev/spark/dist/spark.module.js` を確認した。

- WASM（Rust 製デコーダ）は **base64 文字列として JS に埋め込まれ**、`WebAssembly.compile()` で初期化される。
  外部 `.wasm` ファイルを `fetch` しない。
- Worker は **JS 文字列を Blob URL 化して `new Worker(blobURL)`** で生成する（失敗時は `data:` URL にフォールバック）。
  外部の Worker ファイルは不要。
- 以上から、`vite-plugin-singlefile` でそのまま 1 ファイルに内包でき、`file://` でも動作する見込み → PoC で確認。

### 3. PoC

一時ディレクトリ（`poc/12-gsplat/`、リポジトリには含めない）に、本体と同じ Vite 設定（singlefile、`base: './'`、
`worker.format: 'iife'`）で PoC を作った。ビルドした `dist/index.html` を **`file://` で** Playwright
（Chromium、SwiftShader）から開いて検証した。

PoC のシーン構成は、本体の `Viewer` と条件をそろえた。

- `WebGLRenderer({ antialias: false })`、`camera.up = (0,0,1)`（Z-up）、`OrbitControls`
- 不透明な `THREE.Points` 20 万点（地面）と、スプラット球を貫通する縦の点列（前後関係の確認用）
- `SparkRenderer` を `scene.add()`、`SplatMesh({ fileBytes, fileName })` で読み込み
  （`<input type=file>` から読む実運用と同じ経路）

検証データ:

1. 合成した 3DGS 標準 PLY（INRIA 形式: `x,y,z,nx,ny,nz,f_dc_0..2,opacity,scale_0..2,rot_0..3`）10 万スプラット
2. Spark 公式サンプル `butterfly.spz`（177,132 スプラット、4.0MB）
3. 大座標テスト: 1 の PLY の全座標に `(-30000, 40000, 50)` を加えたもの（5 万スプラット）。
   標準モードと `extSplats: true` の両方で読み込み、`forEachSplat()` で取り出した中心座標と理論値（半径 2m の球面）とのずれを測った。

## 調査結果

| 項目 | 結果 |
|---|---|
| 単一 HTML ビルド | 成功。PoC 全体で 3.05MB（gzip 1.02MB）。Spark 単体（min）は 2.7MB |
| `file://` での起動 | 成功。コンソールエラーなし（出たのは SwiftShader の ReadPixels 性能警告のみ） |
| PLY 読込 | 10 万スプラット / 約 190ms |
| SPZ 読込 | 17.7 万スプラット / 約 1.1s（WASM デコード込み） |
| 点群との同居 | 正常。不透明な `Points` が深度を書き込み、その後にスプラットが半透明で合成されるため、前後関係は正しい（球の内側を通る点列は隠れ、球の外に出た部分だけが見える） |
| 軸の向き | 3DGS データは Y-down（OpenCV/COLMAP 系）のものが多い。Z-up のシーンで正立させるには X 軸まわりの回転が必要。ファイルによって向きが異なるため、UI での切替が必要 |
| **大座標の精度（標準モード）** | **使えない**。Spark の標準格納形式（`PackedSplats`）は中心座標を **float16** で持つ。X=-30000, Y=40000 では量子化幅が数十 m になり、半径 2m の球が **1 本の縦線に潰れた**（最大誤差 2.000m ＝ X/Y の情報がすべて失われた） |
| **大座標の精度（`extSplats: true`）** | **最大誤差 0.002m**。拡張形式（`ExtSplats`）は中心を float32 で持つため、4 万 m 地点でも float32 の量子化幅（約 4mm）以内に収まった |
| 性能 | SwiftShader（ソフトウェア描画）のため FPS は参考にならない。実 GPU での計測は実装後の動作確認で行う |

## 結論・採用方針

- **Spark（`@sparkjsdev/spark` 2.2.0）を採用する。** three.js r186 と互換、単一 HTML・`file://` の制約を満たし、
  既存の `THREE.Points` 描画と同じシーンで前後関係も正しく描画できた。
- **`SplatMesh` は常に `extSplats: true` で生成する。** 測量データは大座標を持つ可能性が高く、
  標準モード（float16）では位置が破綻するため。代わりにメモリ使用量は増える（実装後に実測して README に記載する）。
- 座標の扱い:
  - ファイル内の座標が大きい（実座標で記録された）データは「実座標モード」として、`mesh.position = -origin` で
    既存の原点相対の仕組みに乗せる。
  - 座標が小さい（ローカル座標の）データは「ローカルモード」として、3D モデル重ね合わせ（`ModelOverlay`）と同様に
    位置・倍率・方位角・軸の向きで配置する。
- 距離計測・クリックでの座標取得はスプラットを対象外とする（段階 4 として別 Issue で扱う）。
- バンドルサイズは約 1.5MB → 約 4.2MB（gzip で +約 0.9MB）に増える。配布形態（単一 HTML）は変わらず、
  GitHub Pages での公開にも支障はないため許容する。

反映先: [基本設計書 4章・7章](../basic-design.md#4-機能一覧)、
[詳細設計書 3.13節](../detailed-design.md#313-viewersplatsts--ガウシアンスプラット3dgs表示)

## 参考資料

- Spark: https://sparkjs.dev/ / https://github.com/sparkjsdev/spark
- 3D Gaussian Splatting（INRIA）PLY 形式: https://github.com/graphdeco-inria/gaussian-splatting
- SPZ 形式（Niantic）: https://github.com/nianticlabs/spz
- SOG 形式（PlayCanvas）: https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/
- GaussianSplats3D: https://github.com/mkkellogg/GaussianSplats3D
