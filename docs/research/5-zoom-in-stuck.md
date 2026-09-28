# マウスホイールでのズームイン操作を繰り返すとズームインが効かなくなる

- 関連Issue: #5
- 調査日: 2026-09-25

## 目的・背景

`OrbitControls`（`zoomToCursor = true`、[src/viewer/Viewer.ts](../../src/viewer/Viewer.ts)）を使い、
マウスホイールでカーソル位置を中心にズームしている。ユーザーの実機報告によると、ホイールで
ズームイン操作を繰り返し行っていると、ある時点から**それ以上ズームインが効かなくなる**
（ホイールを回しても視点が近づかなくなる）現象が起きる。原因を調査する。

## 調査内容

`node_modules/three/examples/jsm/controls/OrbitControls.js`（three ^0.186.0 同梱版）のソースを確認した。

- ホイールでのズームは `_dollyIn`/`_dollyOut` が `this._scale` を乗算・除算するだけで、
  実際のカメラ移動は次回の `update()` 内でまとめて行われる（1行:
  `this._scale *= dollyScale;` / `this._scale /= dollyScale;`）。`dollyScale` は
  `_getZoomScale()` が返す値で、`zoomSpeed`（既定値1）に応じたおよそ0.95前後の係数。
- `this.minDistance` は**既定値 `0`**（本プロジェクトでは未設定のためこのまま）。
  `this.maxDistance` も既定値 `Infinity`。
- `zoomToCursor = true` かつ `PerspectiveCamera` の場合、`update()` 内で実際のカメラ移動は
  以下の手順で行われる（該当箇所を確認済み）。
  ```js
  const prevRadius = _v.length();
  newRadius = this._clampDistance( prevRadius * this._scale );
  const radiusDelta = prevRadius - newRadius;
  this.object.position.addScaledVector( this._dollyDirection, radiusDelta );
  ```
  `_clampDistance()` は `Math.max(this.minDistance, Math.min(this.maxDistance, dist))` であり、
  `minDistance = 0` の場合は事実上クランプされず、`newRadius` は `prevRadius * scale` のまま
  何度でも縮み続けられる。
- ここで重要なのは、**1回のホイール操作でカメラ位置に加算される移動量 `radiusDelta` は
  「現在の距離 `prevRadius`」に比例した相対量**だという点（`radiusDelta = prevRadius * (1 - scale)`）。
  ズームインを繰り返して `prevRadius` が小さくなるほど、1回あたりの絶対移動量も比例して
  小さくなっていく。
- JavaScriptの数値は倍精度浮動小数点（64bit）であり、ある数 `x` に対して意味のある変化を
  与えられる最小の加算量はおよそ `|x| × 2.22e-16`（machine epsilon）である。
  `this.object.position.addScaledVector(...)` はカメラの**絶対座標**（本プロジェクトでは
  シーン原点からの距離。`origin`を引いているとはいえ、視点位置自体はデータの空間スケールに
  応じて数十〜数百程度の値を取り得る）に対する加算のため、`radiusDelta` が
  `|position の各成分| × 2.22e-16` を下回ると、加算結果が丸められて**位置がまったく変化しなくなる**。
- 具体例（カメラ位置の大きさを50、`zoomSpeed`既定値1でホイール1ノッチごとに約5%縮む
  ケースで試算）: `prevRadius` が50から始まり、5%ずつ縮めていくと、
  `50 × 0.95^n < 50 × 2.22e-16` となる `n` はおよそ679回。つまり、
  **ホイール操作を数百回程度繰り返す**と、理論上は必ずこの「移動量が丸めで消える」状態に到達し、
  以降は何回ホイールを回しても `this._scale` は変化する（内部状態としては縮み続けようとする）が、
  `radiusDelta` が浮動小数点の分解能を下回るため `object.position` の加算結果が変わらず、
  見た目のズームインが完全に止まる。
- `minDistance` を適切な正の値に設定していれば、`_clampDistance()` によって
  `newRadius` がその値で頭打ちになり、`radiusDelta` が上記の劣化に達するはるか手前で
  ズームが安定して停止するため、この問題は起きない。

## 調査結果

- 原因は `OrbitControls.minDistance` が既定値 `0` のまま使われていること。
  カーソル位置中心ズーム（`zoomToCursor = true`）の実装は、距離に**比例した**絶対移動量を
  カメラ座標に加算する方式のため、距離が十分小さくなると加算量が浮動小数点の丸め誤差以下になり、
  それ以上ズームインができなくなる（「効かなくなる」ように見える）。
- これは点群データのスケールに関わらず起こり得る（距離が十分小さくなるまでホイールを
  回し続ければ必ず再現する）。ホイールを速く・多く回すほど早く到達する。
- 逆にズームアウト方向（`maxDistance` 既定値 `Infinity`）には同種の問題は生じない
  （絶対移動量が増えていく方向のため）。

## 結論・採用方針

`OrbitControls.minDistance` に、シーンのスケールに応じた妥当な正の値を設定し、
浮動小数点の劣化領域に到達するはるか手前でズームインを頭打ちにする。

- コンストラクタで安全側のデフォルト値（データ未読み込み時）を設定する。
- `fitCamera()`（レイヤー読み込み・フィット時に `camera.near`/`camera.far` を
  データの大きさ `size` に応じて設定している箇所、[src/viewer/Viewer.ts](../../src/viewer/Viewer.ts)）
  と同様に、`size` に応じて `controls.minDistance` も更新する
  （`camera.near` と同程度かそれ以上の値とし、近づきすぎて `near` 面クリップで
  見えなくなる前にズームが止まるようにする）。
- これにより、ズームインは「ある程度近づいたところで滑らかに止まる」という明確でユーザーにも
  分かりやすい挙動になり、浮動小数点由来の「操作しても反応しない」不具合を根本的に防げる。
- 設計は [docs/detailed-design.md](../detailed-design.md) の該当節に追記する。

## 追加調査（2026-09-25、`controls.minDistance` 導入後もユーザー実機で再現）

`controls.minDistance` を設定した状態で実機確認したところ、ホイールズームインだけでなく
**右ボタンドラッグによるパン操作も、ある程度ズームインした後に効かなくなる**現象が
引き続き報告された。`minDistance` はOrbitControls自身のズーム処理（前節）を頭打ちにするが、
別経路で `controls.target` がカメラ位置とほぼ一致してしまう不具合が残っていることが判明した。

- `OrbitControls.update()` は**毎フレーム** `this._spherical` を
  `(camera.position - controls.target)` から作り直す（`_v.copy(position).sub(this.target); this._spherical.setFromVector3(_v);`）。
  つまり `minDistance` によるクランプは「OrbitControls自身が動かした場合の半径」にしか効かず、
  **`target` と `position` の関係そのものを外部から不整合な値に書き換えられると無力**である。
- パン量も同様に、`_pan(deltaX, deltaY)` 内で
  `targetDistance = camera.position.distanceTo(controls.target)` を直接使って
  1ピクセルあたりの移動量を決めている（`node_modules/three/examples/jsm/controls/OrbitControls.js`
  の `_pan()`）。したがって `target` が `position` にほぼ重なると、
  ドラッグしても `targetDistance ≈ 0` となり移動量も ≈0 になる＝パンが「効かなくなる」。
- 本プロジェクトの「クリック位置中心の回転」機能（Issue #3、[src/viewer/Viewer.ts](../../src/viewer/Viewer.ts)
  の `onPointerDown` / `onPointerMoveForRotatePivot` / `rotateAroundPivot` / `onPointerUp`）は、
  左ドラッグ中は `controls.enabled = false` にして `OrbitControls.update()` を呼ばず、
  クリックした点 `rotatePivot`（`target` とは別の任意の点）を中心にカメラの位置・向きを
  直接書き換える。ドラッグ終了時の `onPointerUp()` で、OrbitControlsに制御を戻すために
  ```ts
  const dist = this.camera.position.distanceTo(this.controls.target); // 回転前からの target（固定）との距離
  const forward = new THREE.Vector3();
  this.camera.getWorldDirection(forward);
  this.controls.target.copy(this.camera.position).addScaledVector(forward, dist);
  ```
  という処理で新しい `target` を「回転後のカメラ位置」から `dist` だけ前方に置き直している。
  この `dist` は「回転後のカメラ位置」と「ドラッグ開始時点のまま動いていない古い `target`」との
  距離であり、**`rotatePivot` を中心に回転した結果カメラが たまたま古い `target` の近くまで
  スイングすると、`dist` が非常に小さい値（ほぼ0）になり得る**。
- ズームインを繰り返してカメラが点群表面に近づいた状態で、さらにクリック位置中心の回転
  （左ドラッグ）を行うと、カメラの旋回半径 (`rotatePivot`までの距離) が小さいぶん、
  カメラが `target` の位置を追い越す・かすめるような動きになりやすく、上記の `dist` が
  0に近くなる場面に遭遇しやすい。これが「**ズームインをある程度行った後に**パンやズームが
  効かなくなる」というユーザー報告と一致する。
- 一度 `dist ≈ 0` の `target` がセットされると、以降は毎フレーム
  `_spherical.radius ≈ 0` から再計算されるため、次のホイールズームでも
  `prevRadius ≈ 0` からのスタートとなり、`minDistance` によるクランプは
  「新しい半径の下限」としては働くが、**そこに至るまでの1ステップ目の見た目の動き**や
  パン操作の反応性はやはり損なわれる。

### 結論・採用方針（追記）

`onPointerUp()` で新しい `target` を置き直す際の `dist` を、`controls.minDistance` を
下限としてクランプする。

```ts
const dist = Math.max(this.camera.position.distanceTo(this.controls.target), this.controls.minDistance);
```

こうすることで、クリック位置中心の回転の直後であっても `target` と `camera.position` の
距離が必ず `minDistance` 以上に保たれ、その後のOrbitControlsによるズーム・パンの
距離依存の移動量計算が0に潰れることを防げる。この計算はDOM/three.jsの副作用を伴わない
純粋な計算のため、`computeTargetAfterRotate()` のような関数に切り出してユニットテスト可能にする。

## 参考資料

- `node_modules/three/examples/jsm/controls/OrbitControls.js`（three ^0.186.0 同梱ソース、
  `_dollyIn()` / `_dollyOut()` / `_updateZoomParameters()` / `update()` 内のカーソルズーム処理 / `_clampDistance()` /
  `update()` 冒頭の `_spherical.setFromVector3()` によるスフィリカル再計算 / `_pan()` の `targetDistance` 計算）
- [src/viewer/Viewer.ts](../../src/viewer/Viewer.ts) の `fitCamera()` 実装（`camera.near`/`far` を
  `size` から算出している既存パターン）と `onPointerUp()` のクリック位置中心回転の後処理

## 追加調査2（2026-09-25、デバッグ情報パネルによる実測。上記2つの修正を適用済みでも再現）

上記2つの修正（`controls.minDistance` 導入、`computeTargetAfterRotate()` によるtarget距離クランプ）を
適用してビルド・実機確認したが、ユーザーからは**改善しない**との報告があった。理論上のソース解析だけでは
実際に何が起きているか切り分けられなくなったため、画面にカメラ位置・target・距離・`minDistance`等を
毎フレーム表示するデバッグ情報パネルを追加し（`Viewer.getDebugInfo()` / `onDebugUpdate` /
[src/main.ts](../../src/main.ts) の「デバッグ情報」ボタン）、実機で再現手順を踏みながら数値を記録した。

### 観測結果

ズームインを繰り返す過程で採取した値（`distance` = カメラ〜target間距離、`minDistance` = 現在の下限）:

| 段階 | distance | minDistance |
| --- | --- | --- |
| 1（広い視点） | 4.7774e+1 | 1.0303e-2 |
| 2 | 1.5457e+1 | 1.0303e-2 |
| 3 | 6.1396e+0 | 1.0303e-2 |
| 4（ズーム停止・右ドラッグも効かない） | **1.0303e-2** | **1.0303e-2** |

段階4では `distance` と `minDistance` が**完全に一致**しており、これは浮動小数点の丸め誤差による
「意図せぬフリーズ」ではなく、**`controls.minDistance` によるクランプが設計通りに働いてズームインを
頭打ちにしている状態そのもの**であることが確定した（`rotateCandidate`/`rotateActive` はいずれも `false` で、
クリック位置中心回転の関与もないことも確認済み）。左ドラッグの回転操作（OrbitControlsを介さない
独自実装）は `target`/`distance` に依存しないため、この状態でも問題なく動作する（ユーザー報告と一致）。

右ドラッグのパンが効かなくなる件も、この`distance`の値だけで説明できる。`OrbitControls._pan()` は
1ピクセルあたりの移動量を `targetDistance = distance(camera.position, target) * tan(fov/2)` に
比例させて決めているため、`distance ≈ 0.0103`（シーンサイズ ≈ 51.5 に対して約0.02%）まで潰れた状態では、
画面を大きくドラッグしても実際のワールド座標の移動量はミリメートル未満になり、体感上「パンが
効かない」ことになる（試算: fov=60°, `distance`=0.0103 のとき、画面高さいっぱいのドラッグでも
移動量はおよそ0.005程度＝シーンサイズの0.01%程度しかない）。

### 結論・採用方針（修正2の見直し）

`minDistanceForSize(size)` が `camera.near` と同じ比率 `size / 5000` を使っていたため、
「浮動小数点の丸め誤差を避けるための安全下限」のつもりが、実用上のズーム操作で
**数回ホイールを回しただけで到達してしまう、体感上の実用的な上限**になってしまっていた。
これが「ズームインが効かなくなる」「右ドラッグのパンが効かなくなる」の直接原因であり、
浮動小数点の丸め誤差（追加調査1で試算した679回規模のホイール操作が必要な現象）には
実際には到達していない。

対応として、`minDistanceForSize()` を `camera.near` の算出式から切り離し、
浮動小数点精度崩壊（シーン比で1e-15程度）に対して十分な余裕を持たせつつ、
通常のズーム操作では実用上到達しない程度に小さい比率に変更する。

```ts
export function minDistanceForSize(size: number): number {
  return Math.max(1e-6, size * 1e-6);
}
```

`camera.near`（`size / 5000`）はレンダリングのデプスバッファ精度を保つために現状のまま維持し、
`minDistance` とは意図的に一致させない。これにより、ズームインが `near` 面より先に
クリップアーティファクト（近すぎる点が見えなくなる等）として現れる可能性はあるが、
「ズームもパンも完全に無反応になる」状態よりは大幅に改善される。ユーザーには本修正を
デバッグ情報パネル付きで再度実機確認してもらい、以下を確認する。
- 従来ズームが止まっていたポイントを超えてズームインを継続できるか
- 右ドラッグのパンが引き続き機能するか
- （もし新しい下限でも同様の現象が再現する場合）今度こそ浮動小数点の丸め誤差領域に
  到達している可能性が高いため、デバッグパネルの数値を再度採取して切り分ける

## 参考資料（追加）

- 実機でのデバッグ情報パネル採取値（本ドキュメント内表を参照）
- `node_modules/three/examples/jsm/controls/OrbitControls.js` の `_pan()`（`targetDistance` の算出、
  `panLeft`/`panUp` への反映）
