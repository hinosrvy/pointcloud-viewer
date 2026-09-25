"""テスト用の LAS / LAZ を生成する。 pip install laspy lazrs"""
import numpy as np, laspy, sys
n = int(sys.argv[1]) if len(sys.argv) > 1 else 2_000_000
rng = np.random.default_rng(0)
# 平面直角座標系 IX 系（東京付近）を想定
x = rng.uniform(-10000, -9500, n); y = rng.uniform(-35000, -34500, n)
z = 30 + 8 * np.sin(x / 60) * np.cos(y / 80) + rng.normal(0, 0.2, n)
m = (x > -9800) & (x < -9700) & (y > -34800) & (y < -34700); z[m] += 25  # 建物
h = laspy.LasHeader(point_format=3, version="1.2"); h.scales = [0.001] * 3; h.offsets = [-10000, -35000, 0]
las = laspy.LasData(h); las.x, las.y, las.z = x, y, z
las.intensity = (np.clip((z - 20) / 40, 0, 1) * 65535).astype(np.uint16)
las.classification = np.where(m, 6, 2).astype(np.uint8)
t = (z - z.min()) / (z.max() - z.min())
las.red = (t * 65535).astype(np.uint16); las.green = ((1 - t) * 65535).astype(np.uint16); las.blue = np.full(n, 30000, np.uint16)
las.write("sample.las"); las.write("sample.laz"); print("sample.las / sample.laz written")
