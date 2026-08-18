import { describe, expect, it } from "vitest";
import { hashCandidateIds, samplePhysicalPositions, sampleWithoutReplacement, weightedPick } from "../src/domain/random.js";

describe("random selection rules", () => {
  it("uses lower workload candidates with a larger weight", () => {
    const candidates = [
      { id: "busy", activeTaskCount: 4 },
      { id: "free", activeTaskCount: 0 },
    ];
    const result = weightedPick(candidates, () => 2);
    expect(result.selected[0]?.id).toBe("free");
    expect(result.candidateHash).toBe(hashCandidateIds(["busy", "free"]));
  });

  it("samples without duplicate products", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const result = sampleWithoutReplacement(items, 2, () => 0);
    expect(result.selected).toHaveLength(2);
    expect(new Set(result.selected.map((item) => item.id)).size).toBe(2);
  });

  it("rejects sampling more than the candidate count", () => {
    expect(() => sampleWithoutReplacement([{ id: "a" }], 2)).toThrow("抽样数量不能超过候选产品数量");
  });

  it("draws unique pallet-box-item positions", () => {
    let next = 0;
    const result = samplePhysicalPositions({
      orderItemId: "item-1", palletCount: 2, boxesPerPallet: 3, itemsPerBox: 4, sampleCount: 4,
    }, (max) => (next++ * 3) % max);
    expect(result.candidateTotal).toBe(24);
    expect(result.positions).toHaveLength(4);
    const keys = result.positions.map((item) => `${item.palletNo}-${item.boxNo}-${item.itemNo}`);
    expect(new Set(keys).size).toBe(4);
    expect(result.positions.every((item) => item.palletNo <= 2 && item.boxNo <= 3 && item.itemNo <= 4)).toBe(true);
  });
});
