# マウス左ドラッグ回転をクリック位置中心にする

- 関連Issue: #3
- 調査日: 2026-09-25

## 目的・背景

現状、キャンバス上のマウス左ドラッグ回転（`three/addons/controls/OrbitControls.js`）は
常に固定の注視点 `controls.target` を中心に回転する（[src/viewer/Viewer.ts](../../src/viewer/Viewer.ts)）。
画面端の対象物を見ようとすると視点全体が大きく動いてしまい直感的でない。
Potree等の点群ビューアで一般的な「クリックした点を中心に回転する」挙動にしたい。

## 調査内容

`node_modules/three/examples/jsm/controls/OrbitControls.js`（three ^0.186.0 同梱版）のソースを確認した。

- `update()` は毎フレーム呼ばれ、以下の順で処理する。
  1. `_v.copy(position).sub(this.target)` … **現在の** `target` を使ってカメラのオフセットを算出
  2. `_v` を球面座標 `_spherical` に変換
  3. ドラッグ中に蓄積された `_sphericalDelta`（回転量）を加算
  4. 球面座標から `_v` を再計算し、`position.copy(target).add(_v)` でカメラ位置を更新
  5. `this.object.lookAt(this.target)` でカメラ姿勢を注視点に向ける
- そのため、**ポインタダウン時点で `controls.target` を書き換えるだけで良い**。
  ドラッグ開始前（`_sphericalDelta` がまだ0）は上記2〜4の計算結果が元のカメラ位置と一致するため、
  `target` を変更してもカメラの **位置は動かない**。ただし直後の `update()` で
  `lookAt(target)` により視線方向だけ新しい注視点に向く（クリックした点が中央に来る）。
  以降のドラッグ回転はこの新しい `target` を中心に行われる。
- マウスボタンとジェスチャーの対応（`onMouseDown`関数）:
  - 既定値 `mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }`
    （本プロジェクトでは未変更のためこの既定値のまま）。
  - **左ボタン + Ctrl/Meta/Shift は ROTATE ではなく PAN になる**（`onMouseDown`内の分岐）。
    このケースではクリック位置への注視点変更は行うべきではない（回転しないため）。
- 本プロジェクトの `Viewer.ts` には既に `pick(clientX, clientY): THREE.Vector3 | null` という、
  可視レイヤーに対してレイキャストし、点群上の最も近い点（シーン座標）を返すメソッドが存在する
  （計測機能で使用中）。ヒットしない場合は `null` を返す。

## 調査結果

- `controls.target` を左ボタン押下時（回転になる場合のみ）にクリック位置の点群ヒット点へ更新すれば、
  カメラ位置を動かさずに「クリックした点を中心とした回転」が実現できる。
- クリック位置に点群がない場合（`pick()` が `null`）は、現状の `target` を維持すれば従来通りの挙動になる。
- Ctrl/Meta/Shift 押下時（パン操作になる場合）は `target` を変更しない。
- **（初版実装の問題・実機確認で判明）** `pointerdown`の時点で即座に`target`を書き換えると、
  `render()`が毎フレーム呼ぶ`controls.update()`内の`object.lookAt(target)`により、
  ドラッグせず単純にクリックしただけでも視点が瞬時にクリック位置へ向き直ってしまい、
  画面全体が「意図せず少し動く／回転する」ように見える（ユーザー実機確認で報告）。
  計測時の1点クリックのような「ドラッグを伴わない単純クリック」でも発生してしまうため、
  これは許容できない副作用と判断した。

## 追加調査（ドラッグ確定前の余計な回転について）

- 上記方針（4px閾値を超えた時点で`target`を変更）だけでは不十分だった。
  `OrbitControls`自体は自分の`pointermove`リスナを`domElement.ownerDocument`に登録しており（ソース確認済み）、
  間の4pxの移動をすでに旧`target`を中心として少し回転させてしまう。
  その後にこちらが`target`を新しいクリック位置へ変更すると、既に起きた小さな回転（旧中心基準）の上に
  新中心への向き直り（`lookAt`）が重なり、結果として「一度違う方向に少し動いてから
  正しい中心で回転が始まる」という二段階の不自然な動きに見えてしまう（ユーザー実機確認で報告）。
- `OrbitControls.enabled = false` の間は自体の`pointermove`ハンドラが先頭で`return`するため、
  回転・パン・ズームすべてが完全に停止する。ただし内部の`_rotateStart`は更新されずに
  `pointerdown`時点の値のまま凍結されるため、再有効化後の最初の`pointermove`では「ドラッグ開始から
  現在までの移動量をまとめて適用」されるだけで、旧中心での回転は一切発生しない。
  これを利用し、`pointerdown`時点で回転候補なら`controls.enabled = false`にし、
  4px閾値を超えた時点（`target`更新と同時）に`controls.enabled = true`に戻す方式に変更した。

## さらなる追加調査（クリック位置が画面中央にスナップしてしまう根本原因）

- 上記の対策後もユーザー実機確認で「左ボタンダウン後、左ドラッグ開始時に意図しない位置へ移動して
  から回転が始まる」という報告があった。慎重に検証した結果、根本原因は
  **`controls.target`を変更するかぎり、`OrbitControls.update()`が呼ぶ`object.lookAt(target)`により
  そのクリック位置が強制的に画面中央へ移動してしまう**ことだと判明した。
  - `update()`内の計算（`_v = position - target` → 球面座標化 → （`_sphericalDelta`が0なら）
    同じ位置に戻す → `lookAt(target)`）では、カメラの**位置**は変更前後で数学的に一致する
    （既知）。しかし`lookAt(target)`は`target`の方向を強制的にカメラの正面（画面中央）に
    向けるため、**クリック位置が画面中央でない限り、`target`を切り替えた瞬間にカメラの
    向きが変わり、見た目が動く**。これは`4px`閾値の有無や、変更するタイミング（`pointerdown`か
    `pointermove`か）に関係なく、`OrbitControls`の`target`ベースの設計に内在する制約であり、
    「`target`を変えても位置は動かない」という以前の調査結果だけでは見た目の変化を防げないと
    わかった。
  - つまり、`OrbitControls`の`target`/`lookAt`の仕組みをそのまま使う限り、クリックした点を
    画面内の任意の位置（中央でなくても良い）に固定したまま回転を始めることはできない。
    `target`は常に画面中央に強制されるため、クリック位置＝画面中央の場合を除き必ず視点の
    「向き直り」が発生してしまう。

## 結論・採用方針（最終版）

`OrbitControls`の`target`/`lookAt`方式では要件（クリック位置を画面上で動かさずに、その点を
中心として回転する）を満たせないため、ドラッグによる回転処理を独自実装に置き換えた。

1. `pointerdown`時点では何もせず、回転候補（左ボタン・非ウォーク・修飾キーなし）の場合のみ
   `controls.enabled = false` にして`OrbitControls`の入力処理を一時停止する。
2. **実際にドラッグと判定された瞬間（4px以上動いた最初の`pointermove`）**に、`pointerdown`時点の
   座標を`pick()`でレイキャストし、ヒットした点を回転中心（`rotatePivot`、ワールド座標）として
   記録する。ヒットしない場合は`controls.enabled = true`に戻して通常の`OrbitControls`回転
   （既存の`target`中心）に任せる。
3. ドラッグ中の各`pointermove`では、`OrbitControls`を一切介さず、直前のポインタ位置からの
   移動量（dx, dy）だけを使い、**カメラの位置と向き（quaternion）を同時に、剛体として
   `rotatePivot`を中心に回転**させる（`rotateAroundPivot()`）。具体的には
   `camera.position - rotatePivot` のオフセットベクトルを世界の上方向（`camera.up`）まわりに
   ヨー回転、続けてその後のカメラのローカル右方向まわりにピッチ回転し、同じ回転量を
   `camera.quaternion`にも適用してからカメラ位置を`rotatePivot + 回転後オフセット`に更新する。
   `lookAt()`は一切呼ばないため、クリックした点が画面中央へ強制的に移動することはなく、
   ドラッグ開始時点の見た目のまま、その点を中心に回転が始まる。
4. 独自回転中は`render()`内の`controls.update()`の呼び出し自体をスキップする（`update()`は
   毎フレーム無条件で`lookAt(target)`を呼ぶため、呼んでしまうと独自に設定した向きが
   毎フレーム上書きされてしまうため）。
5. `pointerup`時、独自回転を行っていた場合は`controls.target`を**カメラの現在の正面方向**上の
   点に置き直す（`camera.position + forward * dist`）。この点は定義上すでに画面中央
   （＝カメラの正面）にあるため、`lookAt(target)`を呼んでも向きは変化せず、後続の通常の
   `OrbitControls`操作に視点ジャンプなしで引き継げる。その後`controls.enabled = true`に戻す。
   ドラッグに至らなかった単純クリックの場合は`target`を変更せず、`enabled`を戻すだけ。

これにより、単純クリック（計測のピック等）では視点は変化せず、実際に左ドラッグで回転を始めた
場合はクリック位置が画面上で動くことなく、その点を中心とした回転になる。
設計は [docs/detailed-design.md](../detailed-design.md) の該当モジュール節に追記する。

## 参考資料

- `node_modules/three/examples/jsm/controls/OrbitControls.js`（three ^0.186.0 同梱ソース、`update()` / `onMouseDown()`）
- [src/viewer/Viewer.ts](../../src/viewer/Viewer.ts) の `pick()` / `onPointerDown()` 実装
