import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLocation } from "../src/services/map-location.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Chinese photo check-in address", () => {
  it("requests Chinese reverse geocoding and keeps the source", async () => {
    vi.stubEnv("MAP_PROVIDER", "osm");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ display_name: "安徽省, 合肥市, 蜀山区, 潜山路" }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveLocation(31.8494038, 117.2271186, "Shanghai Local Dev Test Site");

    expect(result).toEqual({ address: "安徽省, 合肥市, 蜀山区, 潜山路", provider: "OSM", coordinateSystem: "WGS84" });
    const [url, options] = fetchMock.mock.calls[0] as [URL, { headers: Record<string, string> }];
    expect(url.searchParams.get("accept-language")).toContain("zh-CN");
    expect(options.headers["Accept-Language"]).toContain("zh-CN");
  });

  it("does not mislabel an English order address as a GPS address", async () => {
    vi.stubEnv("MAP_PROVIDER", "none");
    expect(await resolveLocation(31.8, 117.2, "Shanghai Local Dev Test Site"))
      .toEqual({ address: "定位地址暂未解析", provider: "ORDER_ADDRESS", coordinateSystem: "WGS84" });
  });
});
