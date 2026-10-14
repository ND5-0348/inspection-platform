import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryStore, store } from "../src/store/memory-store.js";
import { hashCandidateIds } from "../src/domain/random.js";

const app = await buildApp();
let headers: { authorization: string };
const url = "/api/v1/orders/ord-demo-1/dispatch";

beforeEach(async () => {
  const fresh = new MemoryStore();
  store.users = fresh.users;
  store.orders = fresh.orders;
  store.tasks = fresh.tasks;
  store.randomAudits = [];
  store.auditLogs = [];
  store.sessions.clear();
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { employeeNo: "A001", password: "Admin@123" } });
  headers = { authorization: `Bearer ${login.json().token}` };
});
afterAll(async () => { await app.close(); });

describe("administrator selected candidate dispatch", () => {
  it("assigns the sole chosen person and records the original candidate weight", async () => {
    const response = await app.inject({ method: "POST", url, headers, payload: { candidateIds: ["usr-sampler-1"] } });
    expect(response.statusCode).toBe(201);
    expect(response.json().assigneeId).toBe("usr-sampler-1");
    expect(store.users.find((person) => person.id === "usr-sampler-1")!.activeTaskCount).toBe(2);
    expect(store.auditLogs[0]!.detail).toMatchObject({ assignmentMode: "DIRECT", requestedCandidateIds: ["usr-sampler-1"], candidates: [{ id: "usr-sampler-1", activeTaskCount: 1, weight: 8 }] });
    expect(store.randomAudits[0]!.candidateCount).toBe(1);
    const again = await app.inject({ method: "POST", url, headers, payload: { candidateIds: ["usr-sampler-2"] } });
    expect(again.statusCode).toBe(409);
    expect(store.tasks.filter((task) => task.orderId === "ord-demo-1")).toHaveLength(1);
  });

  it("uses only the three selected people even when a fourth is eligible", async () => {
    const template = store.users[2]!;
    store.users.push({ ...template, id: "candidate-3", employeeNo: "T003", name: "候选三" }, { ...template, id: "outside", employeeNo: "T004", name: "名单外人员" });
    const ids = ["usr-sampler-1", "usr-sampler-2", "candidate-3"];
    const response = await app.inject({ method: "POST", url, headers, payload: { candidateIds: ids } });
    expect(response.statusCode).toBe(201);
    expect(ids).toContain(response.json().assigneeId);
    expect(store.randomAudits[0]).toMatchObject({ candidateCount: 3, candidateHash: hashCandidateIds(ids), ruleVersion: "assignment-v2" });
    expect(store.auditLogs[0]!.detail).toMatchObject({ assignmentMode: "SELECTED_RANDOM", requestedCandidateIds: ids });
    expect((store.auditLogs[0]!.detail.candidates as { id: string }[]).map((person) => person.id).sort()).toEqual([...ids].sort());
  });

  it.each([
    ["empty", []], ["duplicate", ["usr-sampler-1", "usr-sampler-1"]],
    ["null", null], ["non-array", "usr-sampler-1"],
  ])("rejects %s selection without creating a task", async (_label, candidateIds) => {
    const response = await app.inject({ method: "POST", url, headers, payload: { candidateIds } });
    expect(response.statusCode).toBe(400);
    expect(store.orders[0]!.status).toBe("PENDING_DISPATCH");
    expect(store.randomAudits).toHaveLength(0);
  });

  it.each(["missing", "admin", "leave", "inactive", "qualification", "capacity"])("rejects an invalid %s candidate without falling back", async (condition) => {
    const person = store.users[2]!;
    let id = person.id;
    if (condition === "missing") id = "does-not-exist";
    if (condition === "admin") id = "usr-admin";
    if (condition === "leave") person.status = "ON_LEAVE";
    if (condition === "inactive") person.status = "INACTIVE";
    if (condition === "qualification") person.qualifications = [];
    if (condition === "capacity") person.activeTaskCount = 5;
    const response = await app.inject({ method: "POST", url, headers, payload: { candidateIds: ["usr-sampler-1", id] } });
    expect(response.statusCode).toBe(409);
    expect(store.tasks).toHaveLength(1);
    expect(store.randomAudits).toHaveLength(0);
    expect(store.orders[0]!.status).toBe("PENDING_DISPATCH");
  });

  it("preserves all-eligible random dispatch when no selection is supplied", async () => {
    const response = await app.inject({ method: "POST", url, headers, payload: {} });
    expect(response.statusCode).toBe(201);
    expect(store.randomAudits[0]!.candidateCount).toBe(2);
    expect(store.auditLogs[0]!.detail.assignmentMode).toBe("ALL_RANDOM");
  });

  it("rejects an all-person draw with no eligible candidate", async () => {
    store.users.filter((person) => person.role === "SAMPLER").forEach((person) => { person.status = "ON_LEAVE"; });
    const response = await app.inject({ method: "POST", url, headers, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(store.tasks).toHaveLength(1);
  });

  it("forbids a sampler from specifying an assignee", async () => {
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { employeeNo: "S001", password: "Sampler@123" } });
    const response = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${login.json().token}` }, payload: { candidateIds: ["usr-sampler-1"] } });
    expect(response.statusCode).toBe(403);
    expect(store.tasks).toHaveLength(1);
  });
});
