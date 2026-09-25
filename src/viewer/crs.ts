import proj4 from 'proj4';

export interface CrsDef {
  code: string;
  name: string;
  proj: string;
}

// 平面直角座標系 (I〜XIX 系) の原点
const ZONES: [string, number, number][] = [
  ['I', 33, 129.5], ['II', 33, 131], ['III', 36, 132.1666666666667], ['IV', 33, 133.5],
  ['V', 36, 134.3333333333333], ['VI', 36, 136], ['VII', 36, 137.1666666666667], ['VIII', 36, 138.5],
  ['IX', 36, 139.8333333333333], ['X', 40, 140.8333333333333], ['XI', 44, 140.25], ['XII', 44, 142.25],
  ['XIII', 44, 144.25], ['XIV', 26, 142], ['XV', 26, 127.5], ['XVI', 26, 124],
  ['XVII', 26, 131], ['XVIII', 20, 136], ['XIX', 26, 154],
];

const tm = (lat0: number, lon0: number) =>
  `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
const utm = (zone: number) => `+proj=utm +zone=${zone} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;

export const CRS_LIST: CrsDef[] = [
  ...ZONES.map(([n, lat, lon], i) => ({ code: `EPSG:${6669 + i}`, name: `平面直角座標系 ${n} 系 (JGD2011, EPSG:${6669 + i})`, proj: tm(lat, lon) })),
  ...ZONES.map(([n, lat, lon], i) => ({ code: `EPSG:${2443 + i}`, name: `平面直角座標系 ${n} 系 (JGD2000, EPSG:${2443 + i})`, proj: tm(lat, lon) })),
  ...[51, 52, 53, 54, 55].map((z, i) => ({ code: `EPSG:${6688 + i}`, name: `UTM ${z} 帯 (JGD2011, EPSG:${6688 + i})`, proj: utm(z) })),
  ...[51, 52, 53, 54, 55].map((z) => ({ code: `EPSG:${32600 + z}`, name: `UTM ${z}N 帯 (WGS84, EPSG:${32600 + z})`, proj: `+proj=utm +zone=${z} +datum=WGS84 +units=m +no_defs` })),
  { code: 'EPSG:3857', name: 'Web メルカトル (EPSG:3857)', proj: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs' },
];

const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';

export class Crs {
  private fwd: proj4.Converter;
  constructor(readonly def: CrsDef, readonly swapXY: boolean) {
    this.fwd = proj4(WGS84, def.proj);
  }
  /** 経緯度 → 点群の座標 (X=東, Y=北 に並べ替え済み) */
  toLocal(lon: number, lat: number): [number, number] {
    const [e, n] = this.fwd.forward([lon, lat]);
    return this.swapXY ? [n, e] : [e, n];
  }
  /** 点群の座標 → 経緯度 */
  toLonLat(x: number, y: number): [number, number] {
    const [e, n] = this.swapXY ? [y, x] : [x, y];
    const [lon, lat] = this.fwd.inverse([e, n]);
    return [lon, lat];
  }
}

/** WKT から EPSG コードをそれらしく推定 */
export function guessCrsFromWkt(wkt?: string): CrsDef | null {
  if (!wkt) return null;
  const m = wkt.match(/ID\["EPSG",(\d+)\]\]?\s*$/) ?? wkt.match(/AUTHORITY\["EPSG","(\d+)"\]\]\s*$/);
  if (m) {
    const code = `EPSG:${m[1]}`;
    return CRS_LIST.find((c) => c.code === code) ?? null;
  }
  const z = wkt.match(/CS (\w+)\b/) ?? wkt.match(/zone (\w+)/i);
  if (z) return CRS_LIST.find((c) => c.name.startsWith(`平面直角座標系 ${z[1]} 系 (JGD2011`)) ?? null;
  return null;
}
