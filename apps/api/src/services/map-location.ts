export interface ResolvedLocation {
  address: string;
  provider: "BAIDU" | "AMAP" | "OSM" | "ORDER_ADDRESS";
  coordinateSystem: "WGS84";
}

async function getJson(url: URL, headers?: Record<string, string>): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) throw new Error(`地图服务返回 ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// All users of this LAN deployment share one upstream limit. Cache nearby repeat
// lookups and serialize cache misses to stay below Nominatim's 1 request/second cap.
const osmCache = new Map<string, { address: string; expiresAt: number }>();
let osmQueue: Promise<void> = Promise.resolve();
let nextOsmRequestAt = 0;

async function reverseWithOsm(latitude: number, longitude: number): Promise<string> {
  const key = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
  const cached = osmCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.address;
  const task = osmQueue.then(async () => {
    const queuedCache = osmCache.get(key);
    if (queuedCache && queuedCache.expiresAt > Date.now()) return queuedCache.address;
    const delay = Math.max(0, nextOsmRequestAt - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    nextOsmRequestAt = Date.now() + 1100;
    const url = new URL(process.env.OSM_REVERSE_URL || "https://nominatim.openstreetmap.org/reverse");
    url.search = new URLSearchParams({
      format: "jsonv2", lat: latitude.toFixed(7), lon: longitude.toFixed(7),
      zoom: "18", "accept-language": "zh-CN,zh;q=0.9", addressdetails: "1",
    }).toString();
    const data = await getJson(url, {
      "User-Agent": "InspectionPlatformLAN/0.1 (on-demand photo check-in; local deployment)",
      "Accept-Language": "zh-CN,zh;q=0.9",
    });
    const address = String(data.display_name || "").trim();
    if (!address || !/[\u3400-\u9fff]/u.test(address)) throw new Error("未取得中文地址");
    osmCache.set(key, { address, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    return address;
  });
  osmQueue = task.then(() => undefined, () => undefined);
  return task;
}

async function reverseWithBaidu(latitude: number, longitude: number, key: string): Promise<string> {
  const url = new URL("https://api.map.baidu.com/reverse_geocoding/v3/");
  url.search = new URLSearchParams({
    ak: key,
    output: "json",
    coordtype: "wgs84ll",
    location: `${latitude.toFixed(7)},${longitude.toFixed(7)}`,
  }).toString();
  const data = await getJson(url);
  if (data.status !== 0 || !data.result?.formatted_address) throw new Error("百度地图逆地理编码失败");
  return String(data.result.formatted_address);
}

async function reverseWithAmap(latitude: number, longitude: number, key: string): Promise<string> {
  const convertUrl = new URL("https://restapi.amap.com/v3/assistant/coordinate/convert");
  convertUrl.search = new URLSearchParams({
    key,
    locations: `${longitude.toFixed(6)},${latitude.toFixed(6)}`,
    coordsys: "gps",
    output: "JSON",
  }).toString();
  const converted = await getJson(convertUrl);
  if (converted.status !== "1" || !converted.locations) throw new Error("高德坐标转换失败");

  const reverseUrl = new URL("https://restapi.amap.com/v3/geocode/regeo");
  reverseUrl.search = new URLSearchParams({ key, location: String(converted.locations), output: "JSON" }).toString();
  const data = await getJson(reverseUrl);
  if (data.status !== "1" || !data.regeocode?.formatted_address) throw new Error("高德地图逆地理编码失败");
  return String(data.regeocode.formatted_address);
}

export async function resolveLocation(latitude: number, longitude: number, fallbackAddress: string): Promise<ResolvedLocation> {
  const provider = (process.env.MAP_PROVIDER ?? "none").toLowerCase();
  try {
    if (provider === "baidu" && process.env.BAIDU_MAP_AK) {
      return { address: await reverseWithBaidu(latitude, longitude, process.env.BAIDU_MAP_AK), provider: "BAIDU", coordinateSystem: "WGS84" };
    }
    if (provider === "amap" && process.env.AMAP_WEB_SERVICE_KEY) {
      return { address: await reverseWithAmap(latitude, longitude, process.env.AMAP_WEB_SERVICE_KEY), provider: "AMAP", coordinateSystem: "WGS84" };
    }
    if (provider === "osm") {
      return { address: await reverseWithOsm(latitude, longitude), provider: "OSM", coordinateSystem: "WGS84" };
    }
  } catch {
    // 地图服务超时或配额异常时仍允许现场作业，保留原始坐标并回退到检测地址。
  }
  const address = /[\u3400-\u9fff]/u.test(fallbackAddress) ? fallbackAddress : "定位地址暂未解析";
  return { address, provider: "ORDER_ADDRESS", coordinateSystem: "WGS84" };
}
