import * as THREE from 'three';
import { loadPointCloud } from './las/loader';
import type { LasHeader } from './las/format';
import { Viewer } from './viewer/Viewer';
import type { Layer } from './viewer/Viewer';
import type { ColorMode } from './viewer/shaders';
import { CRS_LIST, Crs, guessCrsFromWkt } from './viewer/crs';
import { MapOverlay, ModelOverlay, PhotoOverlay, TILE_SOURCES } from './viewer/overlays';
import { button, checkbox, el, fileButton, fmtInt, numberInput, section, select, slider } from './ui';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const panel = document.getElementById('panel')!;
const status = document.getElementById('status')!;
const coordBox = document.getElementById('coord')!;
const toolbar = document.getElementById('toolbar')!;
const attribution = document.getElementById('attribution')!;
const dropOverlay = document.getElementById('drop-overlay')!;

const viewer = new Viewer(canvas);
const mapOverlay = new MapOverlay(viewer);
const modelOverlay = new ModelOverlay(viewer);
const photoOverlay = new PhotoOverlay(viewer);

let budget = 3_000_000;
let lastPick: [number, number, number] | null = null;

function setStatus(msg: string, isError = false) {
  status.textContent = msg;
  status.className = isError ? 'error' : '';
}

// =============================================================== ファイル
interface LayerEntry {
  layer: Layer | null;
  source: File | string;
  name: string;
  row: HTMLDivElement;
  cancel: () => void;
}
const entries: LayerEntry[] = [];

const fileSection = section('ファイル');
const layerList = el('div');
const drop = el('div', { class: 'drop', text: 'ここにファイルをドロップ（複数可）\n.las / .laz / .copc.laz' });
drop.style.whiteSpace = 'pre-line';
drop.addEventListener('click', () => openBtn.click());
const openBtn = fileButton('ファイルを開く…', '.las,.laz', true, (files) => files.forEach((f) => addSource(f, f.name)), 'primary');
const urlInput = el('input', { type: 'text', placeholder: 'https://…/file.copc.laz（Range 対応サーバー）' });
const urlBtn = button('URL から読込', () => {
  const u = urlInput.value.trim();
  if (u) addSource(u, u.split('/').pop() ?? u);
});
const budgetRow = slider('表示点数上限', { min: 100_000, max: 20_000_000, step: 100_000, value: budget, format: (v) => `${(v / 1e6).toFixed(1)}M` }, (v) => (budget = v));
const reloadBtn = button('上限を適用して再読込', () => {
  for (const e of [...entries]) {
    removeEntry(e);
    addSource(e.source, e.name);
  }
});
fileSection.append(
  drop,
  el('div', { class: 'row' }, openBtn),
  el('div', { class: 'row' }, urlInput, urlBtn),
  budgetRow,
  el('div', { class: 'row' }, reloadBtn),
  el('div', { class: 'small', text: '1ファイルあたりの表示点数。上限を超える分は均等に間引きます（COPC は階層レベルで選択）' }),
  layerList,
);
panel.append(el('h1', { text: '点群ビューア' }), fileSection);

function addSource(source: File | string, name: string) {
  const nameEl = el('div', { class: 'name', text: name });
  nameEl.title = name;
  const meta = el('div', { class: 'meta', text: '読み込み中…' });
  const prog = el('progress', { max: 1, value: 0 });
  const vis = el('input', { type: 'checkbox' });
  vis.checked = true;
  const removeBtn = button('×', () => removeEntry(entry), 'danger');
  const zoomBtn = button('⌖', () => {
    if (entry.layer) viewer.fitToLayer(entry.layer);
  });
  zoomBtn.title = 'このファイルにズーム';
  const row = el('div', { class: 'layer' }, vis, el('div', { style: 'flex:1;min-width:0' }, nameEl, meta, prog), zoomBtn, removeBtn);
  layerList.append(row);
  const entry: LayerEntry = { layer: null, source, name, row, cancel: () => {} };
  entries.push(entry);
  vis.addEventListener('change', () => entry.layer && viewer.setLayerVisible(entry.layer, vis.checked));

  const t0 = performance.now();
  const { promise, cancel } = loadPointCloud(source, budget, {
    onHeader: (header: LasHeader, mode) => {
      entry.layer = viewer.addLayer(name, header);
      viewer.setLayerVisible(entry.layer, vis.checked);
      const modeLabel = mode === 'copc' ? 'COPC' : mode === 'laz' ? 'LAZ' : 'LAS';
      meta.textContent = `${modeLabel} ${header.versionMajor}.${header.versionMinor} / PDRF ${header.pointFormat} / ${fmtInt(header.pointCount)} 点`;
      if (header.wkt && !crsSelectEl.dataset.userSet) {
        const g = guessCrsFromWkt(header.wkt);
        if (g) crsSelectEl.value = g.code;
      }
      refreshRanges();
    },
    onCopcPlan: (p) => setStatus(`COPC: ${p.usedNodes}/${p.totalNodes} ノード（レベル ${p.maxLevel} まで）を読み込みます`),
    onBatch: (b) => entry.layer && viewer.appendBatch(entry.layer, b),
    onProgress: (f, pts) => {
      prog.value = f;
      setStatus(`${name}: ${Math.round(f * 100)}%  ${fmtInt(pts)} 点`);
    },
    onWarn: (msg) => setStatus(`${name}: ${msg}`),
    onFallback: (reason) => setStatus(`${reason} → メインスレッドで読み込みます（画面が一時的に固まることがあります）`),
  });
  entry.cancel = cancel;
  promise
    .then((n) => {
      prog.remove();
      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      meta.textContent += ` → 表示 ${fmtInt(n)} 点 (${sec}s)`;
      setStatus(`${name} の読み込み完了: ${fmtInt(n)} 点 / ${sec} 秒`);
      refreshRanges();
    })
    .catch((e: Error) => {
      prog.remove();
      const info = entry.layer ? meta.textContent + ' / ' : '';
      meta.textContent = `${info}エラー: ${e.message}`;
      meta.classList.add('error');
      setStatus(`${name}: ${e.message}`, true);
    });
}

function removeEntry(e: LayerEntry) {
  e.cancel();
  if (e.layer) viewer.removeLayer(e.layer);
  e.row.remove();
  entries.splice(entries.indexOf(e), 1);
  refreshRanges();
}

// ドラッグ＆ドロップ
const view = document.getElementById('view')!;
view.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropOverlay.classList.add('show');
});
view.addEventListener('dragleave', () => dropOverlay.classList.remove('show'));
view.addEventListener('drop', (e) => {
  e.preventDefault();
  dropOverlay.classList.remove('show');
  for (const f of e.dataTransfer?.files ?? []) addSource(f, f.name);
});
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  for (const f of e.dataTransfer?.files ?? []) addSource(f, f.name);
});

// =============================================================== 表示
const dispSection = section('表示');
const colorSel = select(
  '色分け',
  [
    { value: 'elevation', label: '標高' },
    { value: 'rgb', label: 'RGB' },
    { value: 'intensity', label: '反射強度' },
    { value: 'classification', label: '分類' },
  ],
  'rgb',
  (v) => viewer.setColorMode(v as ColorMode),
);
const sizeRow = slider('点サイズ', { min: 1, max: 12, step: 0.5, value: 2, format: (v) => `${v}px` }, (v) => viewer.setPointSize(v));
const attRow = checkbox('距離で点サイズを減衰', false, (v) => viewer.setAttenuate(v));
let elevMin: number | null = null;
let elevMax: number | null = null;
const elevMinIn = numberInput('標高 下限', 0, (v) => { elevMin = v; viewer.setElevationRange(elevMin, elevMax); }, 0.1);
const elevMaxIn = numberInput('標高 上限', 0, (v) => { elevMax = v; viewer.setElevationRange(elevMin, elevMax); }, 0.1);
const elevAuto = button('自動', () => { elevMin = elevMax = null; viewer.setElevationRange(null, null); refreshRanges(); });
let intLo = 0, intHi = 0.5;
const intLoRow = slider('強度 下限', { min: 0, max: 1, step: 0.005, value: intLo, format: (v) => (v * 65535).toFixed(0) }, (v) => { intLo = v; viewer.setIntensityRange(intLo, intHi); });
const intHiRow = slider('強度 上限', { min: 0, max: 1, step: 0.005, value: intHi, format: (v) => (v * 65535).toFixed(0) }, (v) => { intHi = v; viewer.setIntensityRange(intLo, intHi); });
const gammaRow = slider('RGB ガンマ', { min: 0.5, max: 2.5, step: 0.05, value: 1, format: (v) => v.toFixed(2) }, (v) => (viewer.shared.uGamma.value = v));
const bgSel = select('背景', [{ value: '1b1e24', label: 'ダーク' }, { value: '000000', label: '黒' }, { value: 'f2f2f2', label: '白' }, { value: '5b7ea6', label: '空' }], '1b1e24', (v) => viewer.setBackground(parseInt(v, 16)));
dispSection.append(colorSel.row, sizeRow, attRow.row, elevMinIn.row, elevMaxIn.row, el('div', { class: 'row' }, elevAuto), intLoRow, intHiRow, gammaRow, bgSel.row);
panel.append(dispSection);

function refreshRanges() {
  if (viewer.bounds.isEmpty() || !viewer.origin) return;
  if (elevMin == null) elevMinIn.input.value = (viewer.bounds.min.z + viewer.origin[2]).toFixed(2);
  if (elevMax == null) elevMaxIn.input.value = (viewer.bounds.max.z + viewer.origin[2]).toFixed(2);
  const c = viewer.bounds.getCenter(new THREE.Vector3());
  const w = viewer.toWorld(c);
  for (const inp of [modelX.input, photoX.input]) if (!inp.dataset.userSet) inp.value = w[0].toFixed(2);
  for (const inp of [modelY.input, photoY.input]) if (!inp.dataset.userSet) inp.value = w[1].toFixed(2);
  for (const inp of [modelZ.input, photoZ.input]) if (!inp.dataset.userSet) inp.value = (viewer.bounds.min.z + viewer.origin[2]).toFixed(2);
}

// ツールバー（視点）
const walkBtn = button('ウォークスルー', () => viewer.setWalkMode(!viewer.walkMode));
const walkHint = el('div', { id: 'walk-hint', text: 'W/↑ 前進  S/↓ 後退  A/D 左右移動  ←/→ 旋回  Q/E 俯仰  R/F 上昇/下降  Shift 高速  ドラッグ 視線  Esc 終了' });
walkHint.style.display = 'none';
view.append(walkHint);
viewer.onWalkModeChange = (on) => {
  walkBtn.classList.toggle('active', on);
  walkHint.style.display = on ? '' : 'none';
  setStatus(on ? 'ウォークスルー中: キーボードで移動できます（Esc で終了）' : '軌道操作に戻りました');
};
toolbar.append(
  button('全体', () => viewer.fitCamera()),
  button('真上', () => viewer.setView('top')),
  button('北から', () => viewer.setView('north')),
  button('東から', () => viewer.setView('east')),
  button('斜め', () => viewer.setView('iso')),
  walkBtn,
);

// =============================================================== ウォークスルー
const walkSection = section('ウォークスルー', false);
const walkSpeed = slider('移動速度', { min: 0.2, max: 20, step: 0.1, value: 1.5, format: (v) => `${v.toFixed(1)} m/s` }, (v) => (viewer.walk.speed = v));
const walkTurn = slider('旋回速度', { min: 15, max: 180, step: 5, value: 60, format: (v) => `${v}°/s` }, (v) => (viewer.walk.turnSpeed = v));
const eyeIn = numberInput('目線高さ [m]', 1.6, () => {}, 0.1);
const walkStart = button('クリック点から開始', () => {
  if (!lastPick) return setStatus('先に点群をクリックして立つ位置を選んでください', true);
  viewer.startWalkAt(lastPick, Number(eyeIn.input.value));
}, 'primary');
walkSection.append(
  el('div', { class: 'row' }, walkStart, button('終了', () => viewer.setWalkMode(false))),
  eyeIn.row,
  walkSpeed,
  walkTurn,
  el('div', { class: 'small', text: 'W/↑: 前進  S/↓: 後退  A/D: 左右移動\n←/→: 左右旋回  Q/E: 上/下俯仰  R/F: 上昇/下降\nShift: 3倍速  左ドラッグ: 視線  ホイール: 前後  Esc: 終了\n前進・後退は水平方向に進みます（床に沿って歩く想定）' }),
);
walkSection.querySelector('.small')!.setAttribute('style', 'white-space:pre-line');
dispSection.after(walkSection);

// =============================================================== 計測
const measSection = section('距離計測');
const measList = el('div', { class: 'small' });
const measBtn = button('計測モード（クリックで2点選択）', () => {
  viewer.measureMode = !viewer.measureMode;
  measBtn.classList.toggle('active', viewer.measureMode);
  canvas.style.cursor = viewer.measureMode ? 'crosshair' : '';
});
const measClear = button('計測を消去', () => {
  viewer.clearMeasurements();
  measList.replaceChildren();
});
measSection.append(el('div', { class: 'row' }, measBtn, measClear), measList);
panel.append(measSection);
viewer.onMeasure = (m) => {
  const dxy = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y);
  measList.append(el('div', { text: `#${viewer.measurements.length}: ${m.distance.toFixed(3)} m（水平 ${dxy.toFixed(3)} m / 高低差 ${(m.b.z - m.a.z).toFixed(3)} m）` }));
};
viewer.onPick = (_scene, world) => {
  lastPick = world;
  coordBox.textContent = `X ${world[0].toFixed(3)}  Y ${world[1].toFixed(3)}  Z ${world[2].toFixed(3)}`;
};

// =============================================================== 地図
const mapSection = section('地図の重ね合わせ', false);
const crsSel = select('座標系', CRS_LIST.map((c) => ({ value: c.code, label: c.name })), 'EPSG:6677', () => (crsSelectEl.dataset.userSet = '1'));
const crsSelectEl = crsSel.select;
const swapRow = checkbox('X=北, Y=東（測量座標系の並び）', false, () => {});
const tileSel = select('地図種別', [...TILE_SOURCES.map((t) => ({ value: t.id, label: t.name })), { value: 'custom', label: 'カスタム (XYZ タイル URL)' }], 'gsi-std', (v) => {
  tileUrlRow.style.display = v === 'custom' ? '' : 'none';
});
const tileUrlInput = el('input', { type: 'text', placeholder: 'https://example.com/tiles/{z}/{x}/{y}.png' });
const tileUrlRow = el('div', { class: 'row' }, el('label', { text: 'タイル URL' }), tileUrlInput);
tileUrlRow.style.display = 'none';
let mapZOffset = -0.5;
const mapZRow = slider('高さオフセット', { min: -50, max: 50, step: 0.5, value: mapZOffset, format: (v) => `${v} m` }, (v) => {
  mapZOffset = v;
  mapOverlay.setZ(viewer.bounds.min.z + mapZOffset);
});
const mapOpRow = slider('不透明度', { min: 0, max: 1, step: 0.05, value: 1, format: (v) => `${Math.round(v * 100)}%` }, (v) => mapOverlay.setOpacity(v));
const mapBuild = button('地図を表示', () => {
  try {
    const def = CRS_LIST.find((c) => c.code === crsSelectEl.value)!;
    const crs = new Crs(def, swapRow.input.checked);
    const src =
      tileSel.select.value === 'custom'
        ? { id: 'custom', name: 'カスタム', url: tileUrlInput.value.trim(), maxZoom: 19, attribution: 'カスタムタイル' }
        : TILE_SOURCES.find((t) => t.id === tileSel.select.value)!;
    if (!src.url.includes('{z}')) throw new Error('タイル URL に {z}/{x}/{y} を含めてください');
    mapOverlay.build(crs, src, viewer.bounds.min.z + mapZOffset);
    attribution.textContent = `地図: ${src.attribution}`;
    setStatus(`地図タイル ${mapOverlay.tileCount} 枚（ズーム ${mapOverlay.zoom}）を配置しました`);
  } catch (e) {
    setStatus((e as Error).message, true);
  }
}, 'primary');
const mapClear = button('消去', () => {
  mapOverlay.clear();
  attribution.textContent = '';
});
mapSection.append(
  crsSel.row,
  swapRow.row,
  tileSel.row,
  tileUrlRow,
  mapZRow,
  mapOpRow,
  el('div', { class: 'row' }, mapBuild, mapClear),
  el('div', { class: 'small', text: '点群の座標系を指定すると、その範囲を覆う地図タイルを点群の最低標高＋オフセットの高さに敷きます。WKT が含まれる場合は自動推定します。' }),
);
panel.append(mapSection);

// =============================================================== 3D モデル
const modelSection = section('3D モデルの重ね合わせ (glb / gltf / obj)', false);
const modelState = { x: 0, y: 0, z: 0, scale: 1, headingDeg: 0, yUp: true };
const applyModel = () => modelOverlay.setPlacement(modelState);
const markUser = (inp: HTMLInputElement) => (inp.dataset.userSet = '1');
const modelX = numberInput('X (東)', 0, (v) => { modelState.x = v; markUser(modelX.input); applyModel(); }, 0.01);
const modelY = numberInput('Y (北)', 0, (v) => { modelState.y = v; markUser(modelY.input); applyModel(); }, 0.01);
const modelZ = numberInput('Z (標高)', 0, (v) => { modelState.z = v; markUser(modelZ.input); applyModel(); }, 0.01);
const modelScale = numberInput('倍率', 1, (v) => { modelState.scale = v; applyModel(); }, 0.01);
const modelHeading = slider('方位角', { min: -180, max: 180, step: 0.5, value: 0, format: (v) => `${v}°` }, (v) => { modelState.headingDeg = v; applyModel(); });
const modelYUp = checkbox('モデルは Y-up（glTF 標準）', true, (v) => { modelState.yUp = v; applyModel(); });
const modelName = el('div', { class: 'small', text: '未読込' });
const modelFile = fileButton('モデルを開く…', '.glb,.gltf,.obj', false, async ([f]) => {
  try {
    setStatus(`${f.name} を読み込み中…`);
    await modelOverlay.load(f);
    modelOverlay.centerOnBase(modelState.yUp);
    placeModelFromInputs();
    const s = modelOverlay.bboxSize;
    modelName.textContent = `${f.name}  (${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} m)`;
    setStatus(`${f.name} を配置しました。位置・倍率・方位角で調整してください`);
  } catch (e) {
    setStatus((e as Error).message, true);
  }
}, 'primary');
function placeModelFromInputs() {
  modelState.x = Number(modelX.input.value);
  modelState.y = Number(modelY.input.value);
  modelState.z = Number(modelZ.input.value);
  applyModel();
}
const modelToPick = button('クリック点に配置', () => {
  if (!lastPick) return setStatus('先に点群をクリックして位置を選んでください', true);
  [modelX.input.value, modelY.input.value, modelZ.input.value] = lastPick.map((v) => v.toFixed(3));
  [modelX.input, modelY.input, modelZ.input].forEach(markUser);
  placeModelFromInputs();
});
const modelClear = button('消去', () => { modelOverlay.clear(); modelName.textContent = '未読込'; });
modelSection.append(el('div', { class: 'row' }, modelFile, modelToPick, modelClear), modelName, modelX.row, modelY.row, modelZ.row, modelScale.row, modelHeading, modelYUp.row);
panel.append(modelSection);

// =============================================================== 写真
const photoSection = section('写真の重ね合わせ (jpg / png)', false);
const photoState = { x: 0, y: 0, z: 0, width: 10, headingDeg: 0, tiltDeg: 0, opacity: 0.8 };
const applyPhoto = () => photoOverlay.setPlacement(photoState);
const photoX = numberInput('X (東)', 0, (v) => { photoState.x = v; markUser(photoX.input); applyPhoto(); }, 0.01);
const photoY = numberInput('Y (北)', 0, (v) => { photoState.y = v; markUser(photoY.input); applyPhoto(); }, 0.01);
const photoZ = numberInput('Z (標高)', 0, (v) => { photoState.z = v; markUser(photoZ.input); applyPhoto(); }, 0.01);
const photoW = numberInput('幅 [m]', 10, (v) => { photoState.width = v; applyPhoto(); }, 0.1);
const photoHeading = slider('方位角', { min: -180, max: 180, step: 0.5, value: 0, format: (v) => `${v}°` }, (v) => { photoState.headingDeg = v; applyPhoto(); });
const photoTilt = slider('傾き', { min: 0, max: 90, step: 1, value: 0, format: (v) => `${v}°` }, (v) => { photoState.tiltDeg = v; applyPhoto(); });
const photoOp = slider('不透明度', { min: 0, max: 1, step: 0.05, value: 0.8, format: (v) => `${Math.round(v * 100)}%` }, (v) => { photoState.opacity = v; applyPhoto(); });
const photoName = el('div', { class: 'small', text: '未読込' });
function placePhotoFromInputs() {
  photoState.x = Number(photoX.input.value);
  photoState.y = Number(photoY.input.value);
  photoState.z = Number(photoZ.input.value);
  applyPhoto();
}
const photoFile = fileButton('写真を開く…', 'image/*', false, async ([f]) => {
  try {
    await photoOverlay.load(f);
    if (!viewer.bounds.isEmpty()) {
      const s = viewer.bounds.getSize(new THREE.Vector3());
      photoState.width = Math.max(1, Math.round(Math.max(s.x, s.y) * 0.3));
      photoW.input.value = String(photoState.width);
    }
    placePhotoFromInputs();
    photoName.textContent = f.name;
    setStatus(`${f.name} を配置しました。傾き 0° で地面に水平、90° で垂直に立ちます`);
  } catch (e) {
    setStatus((e as Error).message, true);
  }
}, 'primary');
const photoToPick = button('クリック点に配置', () => {
  if (!lastPick) return setStatus('先に点群をクリックして位置を選んでください', true);
  [photoX.input.value, photoY.input.value, photoZ.input.value] = lastPick.map((v) => v.toFixed(3));
  [photoX.input, photoY.input, photoZ.input].forEach(markUser);
  placePhotoFromInputs();
});
const photoClear = button('消去', () => { photoOverlay.clear(); photoName.textContent = '未読込'; });
photoSection.append(el('div', { class: 'row' }, photoFile, photoToPick, photoClear), photoName, photoX.row, photoY.row, photoZ.row, photoW.row, photoHeading, photoTilt, photoOp);
panel.append(photoSection);

// =============================================================== ヘルプ
const help = section('操作方法', false);
help.append(
  el('div', { class: 'small', text: '左ドラッグ: 回転 / 右ドラッグ: 移動 / ホイール: ズーム\nクリック: 座標表示（計測モード中は 2 点で距離計測）\n\n大容量ファイルについて:\n・LAS (非圧縮) は分割読み込みするので数 GB でも可\n・COPC (.copc.laz) は必要なノードのみ読み込むので数 GB でも可\n・通常の LAZ は 1.5 GB まで。超える場合は COPC へ変換:\n  pdal translate in.laz out.copc.laz' }),
);
help.querySelector('.small')!.setAttribute('style', 'white-space:pre-line');
panel.append(help);

// URL パラメータ ?url=… で自動読込
const params = new URLSearchParams(location.search);
const autoUrl = params.get('url');
if (autoUrl) {
  urlInput.value = autoUrl;
  addSource(autoUrl, autoUrl.split('/').pop() ?? autoUrl);
}
