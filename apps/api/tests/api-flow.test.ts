import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const uploadDir = mkdtempSync(join(tmpdir(), "inspection-evidence-test-"));
process.env.UPLOAD_DIR = uploadDir;
const { buildApp } = await import("../src/app.js");
const app = await buildApp();

afterAll(async () => {
  await app.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

describe("browser CORS preflight", () => {
  it("allows administrative PATCH and DELETE requests from the local web app", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/users/usr-sampler-3/status",
      headers: {
        origin: "http://127.0.0.1:5173",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(response.headers["access-control-allow-methods"]).toContain("DELETE");
  });
});

describe("complete inspection flow", () => {
  it("dispatches, checks in, samples physical positions, records evidence and approves", async () => {
    const adminLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { employeeNo: "A001", password: "Admin@123" } });
    expect(adminLogin.statusCode).toBe(200);
    const adminHeaders = { authorization: `Bearer ${adminLogin.json().token}` };

    const ordersResponse = await app.inject({ method: "GET", url: "/api/v1/orders", headers: adminHeaders });
    const order = ordersResponse.json().find((item: { status: string }) => item.status === "PENDING_DISPATCH");
    const dispatchResponse = await app.inject({ method: "POST", url: `/api/v1/orders/${order.id}/dispatch`, payload: {}, headers: adminHeaders });
    expect(dispatchResponse.statusCode).toBe(201);
    const task = dispatchResponse.json();

    const usersResponse = await app.inject({ method: "GET", url: "/api/v1/users", headers: adminHeaders });
    const assignee = usersResponse.json().find((user: { id: string }) => user.id === task.assigneeId);
    const samplerLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { employeeNo: assignee.employeeNo, password: "Sampler@123" } });
    const samplerHeaders = { authorization: `Bearer ${samplerLogin.json().token}`, "x-client-channel": "WEB" };

    const acceptResponse = await app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/accept`, payload: {}, headers: samplerHeaders });
    expect(acceptResponse.json().status).toBe("ACCEPTED");

    const checkInBoundary = "----inspection-check-in-boundary";
    const checkInBody = Buffer.concat([
      Buffer.from(`--${checkInBoundary}\r\nContent-Disposition: form-data; name="photo"; filename="签到照片.png"\r\nContent-Type: image/png\r\n\r\n`),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(`\r\n--${checkInBoundary}--\r\n`),
    ]);
    const checkInQuery = new URLSearchParams({ latitude: "31.2304", longitude: "121.4737", accuracy: "18", address: order.siteAddress });
    const checkInResponse = await app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/photo-check-in?${checkInQuery}`, headers: {
      ...samplerHeaders, "content-type": `multipart/form-data; boundary=${checkInBoundary}`,
    }, payload: checkInBody });
    expect(checkInResponse.statusCode).toBe(200);
    expect(checkInResponse.json().evidenceFiles.find((file: { purpose: string }) => file.purpose === "CHECK_IN").sha256).toHaveLength(64);

    const physicalSampleResponse = await app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/physical-sample`, headers: samplerHeaders, payload: {
      orderItemId: order.items[0].id, palletCount: 2, boxesPerPallet: 3, itemsPerBox: 4, sampleCount: 3,
    } });
    expect(physicalSampleResponse.statusCode).toBe(200);
    const physicalSample = physicalSampleResponse.json().physicalSample;
    expect(physicalSample.candidateTotal).toBe(24);
    expect(physicalSample.positions).toHaveLength(3);

    const boundary = "----inspection-test-boundary";
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="evidence"; filename="现场照片.png"\r\nContent-Type: image/png\r\n\r\n`),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const evidenceResponse = await app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/evidence`, headers: {
      ...samplerHeaders, "content-type": `multipart/form-data; boundary=${boundary}`,
    }, payload: multipartBody });
    expect(evidenceResponse.statusCode).toBe(201);
    expect(evidenceResponse.json().purpose).toBe("INSPECTION");
    expect(evidenceResponse.json().sha256).toHaveLength(64);

    const locationResponse = await app.inject({
      method: "GET",
      url: `/api/v1/maps/reverse-geocode?latitude=31.2304&longitude=121.4737&fallbackAddress=${encodeURIComponent(order.siteAddress)}`,
      headers: samplerHeaders,
    });
    expect(locationResponse.statusCode).toBe(200);
    expect(locationResponse.json()).toMatchObject({ address: order.siteAddress, provider: "ORDER_ADDRESS", coordinateSystem: "WGS84" });

    for (const position of physicalSample.positions as Array<{ palletNo: number; boxNo: number; itemNo: number }>) {
      const key = `P${position.palletNo}-B${position.boxNo}-I${position.itemNo}`;
      const sampleBoundary = `----sample-photo-${key}`;
      const sampleBody = Buffer.concat([
        Buffer.from(`--${sampleBoundary}\r\nContent-Disposition: form-data; name="photo"; filename="${key}-watermarked.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
        Buffer.from(`\r\n--${sampleBoundary}--\r\n`),
      ]);
      const capturedAt = new Date().toISOString();
      const sampleQuery = new URLSearchParams({
        sampleKey: key, latitude: "31.2304", longitude: "121.4737", accuracy: "18",
        address: order.siteAddress, coordinateSystem: "WGS84", mapProvider: "ORDER_ADDRESS", capturedAt,
        watermarkText: `任务 ${task.taskNo} · 样品 ${key}\n${order.siteAddress}\nWGS84 31.230400, 121.473700\n拍摄时间 ${capturedAt}`,
        watermarkVersion: "CLIENT_CANVAS_V1",
      });
      const sampleResponse = await app.inject({
        method: "POST", url: `/api/v1/tasks/${task.id}/sample-evidence?${sampleQuery}`,
        headers: { ...samplerHeaders, "content-type": `multipart/form-data; boundary=${sampleBoundary}` }, payload: sampleBody,
      });
      expect(sampleResponse.statusCode).toBe(201);
      expect(sampleResponse.json()).toMatchObject({ purpose: "SAMPLE", sampleKey: key, mapProvider: "ORDER_ADDRESS" });
      expect(sampleResponse.json().sha256).toHaveLength(64);
    }

    const results = physicalSample.positions.map((position: { palletNo: number; boxNo: number; itemNo: number }) => ({
      sampleKey: `P${position.palletNo}-B${position.boxNo}-I${position.itemNo}`,
      conclusion: "PASS",
      note: "外观和标识符合要求",
    }));
    const resultResponse = await app.inject({ method: "PUT", url: `/api/v1/tasks/${task.id}/inspection-results`, headers: samplerHeaders, payload: { results } });
    expect(resultResponse.statusCode).toBe(200);

    const submitResponse = await app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/submit-review`, headers: samplerHeaders, payload: {} });
    expect(submitResponse.json().status).toBe("PENDING_REVIEW");

    const reviewResponse = await app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/review`, headers: adminHeaders, payload: {
      decision: "APPROVE", comment: "三级抽样位置、检测结论和现场证据完整",
    } });
    expect(reviewResponse.statusCode).toBe(200);
    expect(reviewResponse.json().status).toBe("COMPLETED");

    const forbiddenOrders = await app.inject({ method: "GET", url: "/api/v1/orders", headers: samplerHeaders });
    expect(forbiddenOrders.statusCode).toBe(403);
  });
});

describe("sampler account administration", () => {
  it("allows only administrators to create, initialize and deactivate sampler accounts", async () => {
    const adminLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { employeeNo: "A001", password: "Admin@123" } });
    const adminHeaders = { authorization: `Bearer ${adminLogin.json().token}` };
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/users/samplers",
      headers: adminHeaders,
      payload: {
        employeeNo: "T9001",
        name: "账号测试员",
        mobile: "13900009001",
        department: "测试检测组",
        qualifications: ["电气设备"],
        initialPassword: "TempPass123",
      },
    });
    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json()).not.toHaveProperty("passwordHash");
    const sampler = createResponse.json();

    const samplerLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { employeeNo: "T9001", password: "TempPass123" } });
    expect(samplerLogin.statusCode).toBe(200);
    const samplerHeaders = { authorization: `Bearer ${samplerLogin.json().token}` };

    const forbiddenCreate = await app.inject({
      method: "POST",
      url: "/api/v1/users/samplers",
      headers: samplerHeaders,
      payload: {
        employeeNo: "T9002", name: "无权用户", mobile: "13900009002", department: "测试检测组",
        qualifications: ["通用产品"], initialPassword: "TempPass123",
      },
    });
    expect(forbiddenCreate.statusCode).toBe(403);

    const leaveResponse = await app.inject({
      method: "PATCH", url: `/api/v1/users/${sampler.id}/status`, headers: adminHeaders, payload: { status: "ON_LEAVE" },
    });
    expect(leaveResponse.statusCode).toBe(200);
    expect(leaveResponse.json().user.status).toBe("ON_LEAVE");
    const leaveLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { employeeNo: "T9001", password: "TempPass123" } });
    expect(leaveLogin.statusCode).toBe(401);
    const activeResponse = await app.inject({
      method: "PATCH", url: `/api/v1/users/${sampler.id}/status`, headers: adminHeaders, payload: { status: "ACTIVE" },
    });
    expect(activeResponse.statusCode).toBe(200);
    expect(activeResponse.json().user.status).toBe("ACTIVE");

    const resetResponse = await app.inject({
      method: "POST",
      url: `/api/v1/users/${sampler.id}/reset-password`,
      headers: adminHeaders,
      payload: { newPassword: "NewPass456" },
    });
    expect(resetResponse.statusCode).toBe(200);
    const oldPasswordLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { employeeNo: "T9001", password: "TempPass123" } });
    expect(oldPasswordLogin.statusCode).toBe(401);
    const newPasswordLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { employeeNo: "T9001", password: "NewPass456" } });
    expect(newPasswordLogin.statusCode).toBe(200);

    const deleteResponse = await app.inject({ method: "DELETE", url: `/api/v1/users/${sampler.id}`, headers: adminHeaders });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json().user.status).toBe("INACTIVE");
    const inactiveLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { employeeNo: "T9001", password: "NewPass456" } });
    expect(inactiveLogin.statusCode).toBe(401);
  });
});

describe("inspection order deletion", () => {
  it("deletes only orders that have not been dispatched", async () => {
    const adminLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { employeeNo: "A001", password: "Admin@123" } });
    const adminHeaders = { authorization: `Bearer ${adminLogin.json().token}` };
    const orderNo = `DELETE-TEST-${Date.now()}`;
    const createResponse = await app.inject({
      method: "POST", url: "/api/v1/orders", headers: adminHeaders,
      payload: {
        orderNo, customerName: "待删除测试单位", siteAddress: "测试地址1号", productCategory: "通用产品",
        plannedAt: "2026-08-20T01:00:00.000Z",
        items: [{ productCode: "DEL-001", productName: "删除测试物资", batchNo: "DEL-BATCH", quantity: 1 }],
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const order = createResponse.json();

    const deleteResponse = await app.inject({ method: "DELETE", url: `/api/v1/orders/${order.id}`, headers: adminHeaders });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({ orderNo, message: `检测单 ${orderNo} 已删除` });
    const ordersResponse = await app.inject({ method: "GET", url: "/api/v1/orders", headers: adminHeaders });
    expect(ordersResponse.json().some((item: { id: string }) => item.id === order.id)).toBe(false);

    const taskResponse = await app.inject({ method: "GET", url: "/api/v1/tasks", headers: adminHeaders });
    const dispatchedOrder = taskResponse.json()[0].order;
    const protectedResponse = await app.inject({ method: "DELETE", url: `/api/v1/orders/${dispatchedOrder.id}`, headers: adminHeaders });
    expect(protectedResponse.statusCode).toBe(409);
  });
});
