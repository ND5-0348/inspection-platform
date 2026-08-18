import { createHash, randomInt } from "node:crypto";
import type { PhysicalSamplePosition } from "./types.js";

export type RandomInteger = (maxExclusive: number) => number;

export interface WeightedCandidate {
  id: string;
  activeTaskCount: number;
}

export interface RandomSelection<T> {
  selected: T[];
  candidateHash: string;
}

export function hashCandidateIds(ids: string[]): string {
  return createHash("sha256").update([...ids].sort().join("|")).digest("hex");
}

export function weightedPick<T extends WeightedCandidate>(
  candidates: T[],
  rng: RandomInteger = randomInt,
): RandomSelection<T> {
  if (candidates.length === 0) {
    throw new Error("没有符合条件的可分配人员");
  }

  const weights = candidates.map((candidate) => Math.max(1, 10 - candidate.activeTaskCount * 2));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let ticket = rng(totalWeight);

  for (let index = 0; index < candidates.length; index += 1) {
    const weight = weights[index] ?? 1;
    if (ticket < weight) {
      const selected = candidates[index];
      if (!selected) break;
      return { selected: [selected], candidateHash: hashCandidateIds(candidates.map((item) => item.id)) };
    }
    ticket -= weight;
  }

  const fallback = candidates[candidates.length - 1];
  if (!fallback) throw new Error("随机分配失败");
  return { selected: [fallback], candidateHash: hashCandidateIds(candidates.map((item) => item.id)) };
}

export function sampleWithoutReplacement<T extends { id: string }>(
  candidates: T[],
  count: number,
  rng: RandomInteger = randomInt,
): RandomSelection<T> {
  if (!Number.isInteger(count) || count < 1) throw new Error("抽样数量必须为正整数");
  if (count > candidates.length) throw new Error("抽样数量不能超过候选产品数量");

  const pool = [...candidates];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = rng(index + 1);
    [pool[index], pool[swapIndex]] = [pool[swapIndex]!, pool[index]!];
  }

  return {
    selected: pool.slice(0, count),
    candidateHash: hashCandidateIds(candidates.map((item) => item.id)),
  };
}

export interface PhysicalSampleInput {
  orderItemId: string;
  palletCount: number;
  boxesPerPallet: number;
  itemsPerBox: number;
  sampleCount: number;
}

export function samplePhysicalPositions(
  input: PhysicalSampleInput,
  rng: RandomInteger = randomInt,
): { positions: PhysicalSamplePosition[]; candidateTotal: number; candidateHash: string } {
  const dimensions = [input.palletCount, input.boxesPerPallet, input.itemsPerBox, input.sampleCount];
  if (dimensions.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error("托盘、箱、件和抽样数量必须为正整数");
  }
  const candidateTotal = input.palletCount * input.boxesPerPallet * input.itemsPerBox;
  if (!Number.isSafeInteger(candidateTotal) || candidateTotal > 10_000_000) {
    throw new Error("候选件数超过系统允许的上限");
  }
  if (input.sampleCount > candidateTotal) throw new Error("抽样数量不能超过候选总件数");

  const swaps = new Map<number, number>();
  const selectedIndexes: number[] = [];
  for (let sequence = 0; sequence < input.sampleCount; sequence += 1) {
    const remaining = candidateTotal - sequence;
    const drawIndex = rng(remaining);
    const selectedIndex = swaps.get(drawIndex) ?? drawIndex;
    const lastIndex = swaps.get(remaining - 1) ?? remaining - 1;
    swaps.set(drawIndex, lastIndex);
    selectedIndexes.push(selectedIndex);
  }

  const itemsPerPallet = input.boxesPerPallet * input.itemsPerBox;
  const positions = selectedIndexes.map((index, sequence) => {
    const palletNo = Math.floor(index / itemsPerPallet) + 1;
    const insidePallet = index % itemsPerPallet;
    const boxNo = Math.floor(insidePallet / input.itemsPerBox) + 1;
    const itemNo = (insidePallet % input.itemsPerBox) + 1;
    return { sequence: sequence + 1, palletNo, boxNo, itemNo };
  });

  const candidateHash = createHash("sha256")
    .update([input.orderItemId, input.palletCount, input.boxesPerPallet, input.itemsPerBox].join("|"))
    .digest("hex");
  return { positions, candidateTotal, candidateHash };
}
