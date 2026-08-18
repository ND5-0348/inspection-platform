import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bearerToken, requireUser } from "../auth.js";
import { samplePhysicalPositions, sampleWithoutReplacement, weightedPick } from "../domain/random.js";
import type { InspectionTask, User } from "../domain/types.js";
import { parseWeeklyPlanWorkbook } from "../import/excel-order-import.js";
import { resolveLocation } from "../services/map-location.js";
import { openEvidenceFile, saveEvidenceFile } from "../storage/local-evidence.js";
import { store } from "../store/memory-store.js";

const loginSchema = z.object({
  employeeNo: z.string().trim().min(2).max(32),
  password: z.string().min(8).max(128),
});

const samplerStatusSchema = z.object({ status: z.enum(["ACTIVE", "ON_LEAVE"]) });

const orderSchema = z.object({
  orderNo: z.string().trim().min(3).max(64),
  customerName: z.string().trim().min(2).max(120),
  siteAddress: z.string().trim().min(3).max(240),
  productCategory: z.string().trim().min(2).max(80),
  plannedAt: z.iso.datetime(),
  items: z.array(z.object({
    productCode: z.string().trim().min(1).max(64),
    productName: z.string().trim().min(1).max(120),
    batchNo: z.string().trim().min(1).max(64),
    quantity: z.number().int().positive(),
    orderLineId: z.string().trim().max(64).optional(),
    specification: z.string().trim().max(255).optional(),
    sampleQuantity: z.number().int().positive().optional(),
    completedSampleQuantity: z.number().int().nonnegative().optional(),
    sourceSampler: z.string().trim().max(120).optional(),
    sourceStatus: z.string().trim().max(64).optional(),
    remark: z.string().trim().max(500).optional(),
  })).min(1).max(500),
  inspectionType: z.string().trim().max(80).optional(),
  receivingUnit: z.string().trim().max(160).optional(),
  supplierName: z.string().trim().max(160).optional(),
  contactName: z.string().trim().max(80).optional(),
  contactPhone: z.string().trim().max(32).optional(),
  sourceStatus: z.string().trim().max(64).optional(),
  sourceSampler: z.string().trim().max(120).optional(),
  sourceRemarks: z.string().trim().max(500).optional(),
});

const passwordSchema = z.string().min(8).max(128)
  .regex(/[A-Za-z]/, "密码至少包含一个英文字母")
  .regex(/\d/, "密码至少包含一个数字");

const samplerAccountSchema = z.object({
  employeeNo: z.string().trim().min(2).max(32).regex(/^[A-Za-z0-9_-]+$/, "工号只能包含字母、数字、下划线和连字符"),
  name: z.string().trim().min(2).max(80),
  mobile: z.string().trim().min(6).max(32),
  department: z.string().trim().min(2).max(120),
  qualifications: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
  initialPassword: passwordSchema,
});

function canReadTask(user: User, task: InspectionTask): boolean {
  return user.role === "ADMIN" || user.role === "REVIEWER" || task.assigneeId === user.id;
}

function taskDetail(task: InspectionTask) {
  const order = store.orders.find((item) => item.id === task.orderId);
  const selectedItems = order?.items.filter((item) => task.sampleItemIds.includes(item.id)) ?? [];
  return {
    ...task,
    order,
    selectedItems,
    evidenceFiles: task.evidenceFiles ?? [],
    inspectionResults: task.inspectionResults ?? [],
    reviewRecords: task.reviewRecords ?? [],
  };
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "ok", service: "inspection-api", timestamp: new Date().toISOString() }));

  app.get("/maps/reverse-geocode", async (request, reply) => {
    const user = requireUser(request, reply, ["SAMPLER", "ADMIN", "REVIEWER"]);
    if (!user) return;
    const input = z.object({
      latitude: z.coerce.number().min(-90).max(90),
      longitude: z.coerce.number().min(-180).max(180),
      fallbackAddress: z.string().trim().max(500).default(""),
    }).parse(request.query);
    return resolveLocation(input.latitude, input.longitude, input.fallbackAddress);
  });

  app.post("/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const session = store.login(input.employeeNo, input.password);
    if (!session) return reply.code(401).send({ message: "工号或密码不正确" });
    await store.persist();
    return session;
  });

  app.get("/auth/me", async (request, reply) => {
    const user = requireUser(request, reply);
    return user ? { user } : undefined;
  });

  app.post("/auth/logout", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    store.logout(bearerToken(request));
    return reply.code(204).send();
  });

  app.get("/dashboard", async (request, reply) => {
    const user = requireUser(request, reply, ["ADMIN", "REVIEWER"]);
    if (!user) return;
    return {
      pendingDispatch: store.orders.filter((item) => item.status === "PENDING_DISPATCH").length,
      inProgress: store.tasks.filter((item) => ["ACCEPTED", "IN_PROGRESS"].includes(item.status)).length,
      pendingReview: store.tasks.filter((item) => item.status === "PENDING_REVIEW").length,
      completedToday: store.tasks.filter((item) => item.status === "COMPLETED").length,
      activeSamplers: store.users.filter((item) => item.role === "SAMPLER" && item.status === "ACTIVE").length,
      latestAudit: store.auditLogs.slice(0, 6),
    };
  });

  app.get("/users", async (request, reply) => {
    const user = requireUser(request, reply, ["ADMIN"]);
    return user ? store.users : undefined;
  });

  app.post("/users/samplers", async (request, reply) => {
    const actor = requireUser(request, reply, ["ADMIN"]);
    if (!actor) return;
    const input = samplerAccountSchema.parse(request.body);
    const employeeNo = input.employeeNo.toUpperCase();
    if (store.users.some((user) => user.employeeNo.toUpperCase() === employeeNo)) {
      return reply.code(409).send({ message: "该工号已经存在" });
    }
    if (store.users.some((user) => user.mobile === input.mobile)) {
      return reply.code(409).send({ message: "该手机号已经存在" });
    }
    const sampler = store.createSampler({
      employeeNo,
      name: input.name,
      mobile: input.mobile,
      department: input.department,
      qualifications: [...new Set(input.qualifications)],
    }, input.initialPassword, actor.id);
    await store.persist();
    return reply.code(201).send(sampler);
  });

  app.post("/users/:userId/reset-password", async (request, reply) => {
    const actor = requireUser(request, reply, ["ADMIN"]);
    if (!actor) return;
    const { userId } = z.object({ userId: z.string().min(1) }).parse(request.params);
    const { newPassword } = z.object({ newPassword: passwordSchema }).parse(request.body);
    const sampler = store.users.find((user) => user.id === userId);
    if (!sampler) return reply.code(404).send({ message: "抽检员账号不存在" });
    if (sampler.role !== "SAMPLER") return reply.code(400).send({ message: "只能初始化抽检员账号密码" });
    if (sampler.status === "INACTIVE") return reply.code(409).send({ message: "账号已停用，不能初始化密码" });
    store.resetSamplerPassword(sampler, newPassword, actor.id);
    await store.persist();
    return { message: "密码初始化成功，该账号原有登录状态已失效" };
  });

  app.patch("/users/:userId/status", async (request, reply) => {
    const actor = requireUser(request, reply, ["ADMIN"]);
    if (!actor) return;
    const { userId } = z.object({ userId: z.string().min(1) }).parse(request.params);
    const { status } = samplerStatusSchema.parse(request.body);
    const sampler = store.users.find((user) => user.id === userId);
    if (!sampler) return reply.code(404).send({ message: "抽检员账号不存在" });
    if (sampler.role !== "SAMPLER") return reply.code(400).send({ message: "只能修改抽检员状态" });
    if (sampler.status === "INACTIVE") return reply.code(409).send({ message: "已停用账号不能修改状态" });
    if (sampler.status === status) return { user: sampler, message: status === "ACTIVE" ? "账号已经处于启用状态" : "账号已经处于休假状态" };
    if (status === "ON_LEAVE") {
      const unfinishedTask = store.tasks.find((task) => task.assigneeId === sampler.id && !["COMPLETED", "REJECTED"].includes(task.status));
      if (unfinishedTask) return reply.code(409).send({ message: `该抽检员仍有未完成任务 ${unfinishedTask.taskNo}，不能设为休假` });
    }
    store.setSamplerStatus(sampler, status, actor.id);
    await store.persist();
    return { user: sampler, message: status === "ACTIVE" ? "抽检员已恢复启用，可以登录和参与派单" : "抽检员已设为休假，不再参与派单且当前登录已失效" };
  });

  app.delete("/users/:userId", async (request, reply) => {
    const actor = requireUser(request, reply, ["ADMIN"]);
    if (!actor) return;
    const { userId } = z.object({ userId: z.string().min(1) }).parse(request.params);
    const sampler = store.users.find((user) => user.id === userId);
    if (!sampler) return reply.code(404).send({ message: "抽检员账号不存在" });
    if (sampler.role !== "SAMPLER") return reply.code(400).send({ message: "只能删除抽检员账号" });
    if (sampler.status === "INACTIVE") return reply.code(409).send({ message: "该账号已经停用" });
    const unfinishedTask = store.tasks.find((task) => task.assigneeId === sampler.id && !["COMPLETED", "REJECTED"].includes(task.status));
    if (unfinishedTask) return reply.code(409).send({ message: `该抽检员仍有未完成任务 ${unfinishedTask.taskNo}，请先处理任务` });
    store.deactivateSampler(sampler, actor.id);
    await store.persist();
    return { user: sampler, message: "抽检员账号已停用，历史记录已保留" };
  });

  app.get("/orders", async (request, reply) => {
    const user = requireUser(request, reply, ["ADMIN", "REVIEWER"]);
    return user ? store.orders : undefined;
  });

  app.post("/orders", async (request, reply) => {
    const user = requireUser(request, reply, ["ADMIN"]);
    if (!user) return;
    const input = orderSchema.parse(request.body);
    const order = store.createOrder({
      ...input,
      items: input.items.map((item) => ({ ...item, id: randomUUID() })),
    }, user.id);
    await store.persist();
    return reply.code(201).send(order);
  });

  app.post("/orders/import", async (request, reply) => {
    const user = requireUser(request, reply, ["ADMIN"]);
    if (!user) return;
    const part = await request.file();
    if (!part) return reply.code(400).send({ message: "请选择Excel文件" });
    if (!part.filename.toLowerCase().endsWith(".xlsx")) return reply.code(400).send({ message: "只支持.xlsx格式的质检周计划" });
    const parsed = await parseWeeklyPlanWorkbook(await part.toBuffer(), part.filename);
    const skippedOrderNos: string[] = [];
    const createdOrders = parsed.orders.flatMap((draft) => {
      if (store.orders.some((order) => order.orderNo === draft.orderNo)) {
        skippedOrderNos.push(draft.orderNo);
        return [];
      }
      return [store.createOrder(draft, user.id)];
    });
    store.log(user.id, "WEEKLY_PLAN_IMPORTED", "ORDER_IMPORT", randomUUID(), {
      fileName: part.filename, sheetCount: parsed.sheetCount, rowCount: parsed.rowCount,
      createdCount: createdOrders.length, skippedOrderNos,
    });
    await store.persist();
    return reply.code(createdOrders.length > 0 ? 201 : 200).send({
      fileName: part.filename,
      sheetCount: parsed.sheetCount,
      rowCount: parsed.rowCount,
      itemCount: parsed.itemCount,
      createdCount: createdOrders.length,
      skippedCount: skippedOrderNos.length,
      skippedOrderNos,
      orders: createdOrders,
    });
  });

  app.delete("/orders/:orderId", async (request, reply) => {
    const actor = requireUser(request, reply, ["ADMIN"]);
    if (!actor) return;
    const { orderId } = z.object({ orderId: z.string().min(1) }).parse(request.params);
    const order = store.orders.find((item) => item.id === orderId);
    if (!order) return reply.code(404).send({ message: "检测单不存在或已经删除" });
    if (order.status !== "PENDING_DISPATCH") {
      return reply.code(409).send({ message: "该检测单已经派发或执行，不能删除；请保留任务和抽样记录" });
    }
    if (store.tasks.some((task) => task.orderId === order.id)) {
      return reply.code(409).send({ message: "该检测单已经生成任务，不能删除" });
    }
    await store.deleteOrder(order, actor.id);
    await store.persist();
    return { orderId: order.id, orderNo: order.orderNo, message: `检测单 ${order.orderNo} 已删除` };
  });

  app.post("/orders/:orderId/dispatch", async (request, reply) => {
    const user = requireUser(request, reply, ["ADMIN"]);
    if (!user) return;
    const { orderId } = z.object({ orderId: z.string().min(1) }).parse(request.params);
    const order = store.orders.find((item) => item.id === orderId);
    if (!order) return reply.code(404).send({ message: "检测单不存在" });
    if (order.status !== "PENDING_DISPATCH") return reply.code(409).send({ message: "当前状态不能重复派发" });

    const candidates = store.users.filter((candidate) =>
      candidate.role === "SAMPLER" &&
      candidate.status === "ACTIVE" &&
      candidate.qualifications.includes(order.productCategory) &&
      candidate.activeTaskCount < 5,
    );
    const result = weightedPick(candidates);
    const assignee = result.selected[0]!;
    const task: InspectionTask = {
      id: randomUUID(),
      taskNo: `RW-${order.orderNo.replace(/^JC-/, "")}`,
      orderId: order.id,
      assigneeId: assignee.id,
      assigneeName: assignee.name,
      status: "PENDING_ACCEPTANCE",
      assignedAt: new Date().toISOString(),
      sampleItemIds: [],
    };
    store.tasks.unshift(task);
    store.randomAudits.unshift({
      id: randomUUID(), type: "ASSIGNMENT", subjectId: order.id, ruleVersion: "assignment-v1",
      candidateHash: result.candidateHash, candidateCount: candidates.length,
      selectedIds: [assignee.id], createdAt: new Date().toISOString(),
    });
    order.status = "DISPATCHED";
    assignee.activeTaskCount += 1;
    store.log(user.id, "TASK_RANDOMLY_ASSIGNED", "TASK", task.id, { assigneeId: assignee.id, candidateCount: candidates.length });
    await store.persist();
    return reply.code(201).send(task);
  });

  app.get("/tasks", async (request, reply) => {
    const user = requireUser(request, reply, ["ADMIN", "REVIEWER", "SAMPLER"]);
    if (!user) return;
    const tasks = user.role === "SAMPLER" ? store.tasks.filter((item) => item.assigneeId === user.id) : store.tasks;
    return tasks.map(taskDetail);
  });

  app.get("/tasks/:taskId", async (request, reply) => {
    const user = requireUser(request, reply, ["ADMIN", "REVIEWER", "SAMPLER"]);
    if (!user) return;
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) return reply.code(404).send({ message: "任务不存在" });
    if (!canReadTask(user, task)) return reply.code(403).send({ message: "不能查看其他抽样员的任务" });
    return taskDetail(task);
  });

  app.post("/tasks/:taskId/accept", async (request, reply) => {
    const user = requireUser(request, reply, ["SAMPLER"]);
    if (!user) return;
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) return reply.code(404).send({ message: "任务不存在" });
    if (task.assigneeId !== user.id) return reply.code(403).send({ message: "不能接收其他抽样员的任务" });
    if (task.status !== "PENDING_ACCEPTANCE") return reply.code(409).send({ message: "当前状态不能接单" });
    task.status = "ACCEPTED";
    task.acceptedAt = new Date().toISOString();
    const order = store.orders.find((item) => item.id === task.orderId);
    if (order) order.status = "IN_PROGRESS";
    store.log(user.id, "TASK_ACCEPTED", "TASK", task.id, { channel: request.headers["x-client-channel"] ?? "WEB" });
    await store.persist();
    return taskDetail(task);
  });

  app.post("/tasks/:taskId/sample", async (request, reply) => {
    const user = requireUser(request, reply, ["SAMPLER"]);
    if (!user) return;
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const { count } = z.object({ count: z.number().int().positive() }).parse(request.body);
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) return reply.code(404).send({ message: "任务不存在" });
    if (task.assigneeId !== user.id) return reply.code(403).send({ message: "不能操作其他抽样员的任务" });
    if (!task.acceptedAt) return reply.code(409).send({ message: "请先接单再执行抽样" });
    if (task.sampleItemIds.length > 0) return reply.code(409).send({ message: "该任务已经完成抽样，不能重复抽取" });
    const order = store.orders.find((item) => item.id === task.orderId);
    if (!order) return reply.code(404).send({ message: "检测单不存在" });

    const result = sampleWithoutReplacement(order.items, count);
    task.sampleItemIds = result.selected.map((item) => item.id);
    task.status = "IN_PROGRESS";
    store.randomAudits.unshift({
      id: randomUUID(), type: "SAMPLING", subjectId: task.id, ruleVersion: "sampling-v1",
      candidateHash: result.candidateHash, candidateCount: order.items.length,
      selectedIds: task.sampleItemIds, createdAt: new Date().toISOString(),
    });
    store.log(user.id, "PRODUCTS_RANDOMLY_SAMPLED", "TASK", task.id, {
      selectedIds: task.sampleItemIds,
      count,
      channel: request.headers["x-client-channel"] ?? "WEB",
    });
    await store.persist();
    return { task: taskDetail(task), selectedItems: result.selected };
  });

  app.post("/tasks/:taskId/physical-sample", async (request, reply) => {
    const user = requireUser(request, reply, ["SAMPLER"]);
    if (!user) return;
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const input = z.object({
      orderItemId: z.string().min(1),
      palletCount: z.number().int().min(1).max(10000),
      boxesPerPallet: z.number().int().min(1).max(100000),
      itemsPerBox: z.number().int().min(1).max(100000),
      sampleCount: z.number().int().min(1).max(10000),
    }).parse(request.body);
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) return reply.code(404).send({ message: "任务不存在" });
    if (task.assigneeId !== user.id) return reply.code(403).send({ message: "不能操作其他抽样员的任务" });
    if (!task.acceptedAt) return reply.code(409).send({ message: "请先接单再执行抽样" });
    if (!task.checkIn) return reply.code(409).send({ message: "请先完成现场签到再执行抽样" });
    if (task.physicalSample) return reply.code(409).send({ message: "三级抽样已经完成，不能重复抽取" });
    const order = store.orders.find((item) => item.id === task.orderId);
    const orderItem = order?.items.find((item) => item.id === input.orderItemId);
    if (!order || !orderItem) return reply.code(404).send({ message: "产品批次不存在" });

    const result = samplePhysicalPositions(input);
    task.physicalSample = {
      id: randomUUID(),
      productCode: orderItem.productCode,
      productName: orderItem.productName,
      batchNo: orderItem.batchNo,
      ...input,
      candidateTotal: result.candidateTotal,
      candidateHash: result.candidateHash,
      ruleVersion: "physical-sampling-v1",
      positions: result.positions,
      createdBy: user.id,
      createdAt: new Date().toISOString(),
    };
    task.status = "IN_PROGRESS";
    const selectedKeys = result.positions.map((position) => `P${position.palletNo}-B${position.boxNo}-I${position.itemNo}`);
    store.randomAudits.unshift({
      id: randomUUID(), type: "SAMPLING", subjectId: task.id, ruleVersion: "physical-sampling-v1",
      candidateHash: result.candidateHash, candidateCount: result.candidateTotal,
      selectedIds: selectedKeys, createdAt: new Date().toISOString(),
    });
    store.log(user.id, "PHYSICAL_POSITIONS_RANDOMLY_SAMPLED", "TASK", task.id, {
      productCode: orderItem.productCode,
      palletCount: input.palletCount,
      boxesPerPallet: input.boxesPerPallet,
      itemsPerBox: input.itemsPerBox,
      sampleCount: input.sampleCount,
      candidateTotal: result.candidateTotal,
      selectedKeys,
      channel: request.headers["x-client-channel"] ?? "WEB",
    });
    await store.persist();
    return taskDetail(task);
  });

  app.post("/tasks/:taskId/check-in", async (request, reply) => {
    const user = requireUser(request, reply, ["SAMPLER"]);
    if (!user) return;
    return reply.code(400).send({ message: "签到必须拍摄现场照片，请使用图片签到" });
  });

  app.post("/tasks/:taskId/photo-check-in", async (request, reply) => {
    const user = requireUser(request, reply, ["SAMPLER"]);
    if (!user) return;
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const input = z.object({
      latitude: z.coerce.number().min(-90).max(90),
      longitude: z.coerce.number().min(-180).max(180),
      accuracy: z.coerce.number().min(0).max(10000),
      address: z.string().trim().max(240).optional(),
    }).parse(request.query);
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) return reply.code(404).send({ message: "任务不存在" });
    if (task.assigneeId !== user.id) return reply.code(403).send({ message: "不能操作其他抽样员的任务" });
    if (!task.acceptedAt) return reply.code(409).send({ message: "请先接单再签到" });
    if (!["ACCEPTED", "IN_PROGRESS"].includes(task.status)) return reply.code(409).send({ message: "当前任务状态不能修改签到记录" });
    if (task.evidenceFiles?.some((file) => file.purpose === "CHECK_IN")) return reply.code(409).send({ message: "该任务已经完成图片签到" });
    const part = await request.file();
    if (!part) return reply.code(400).send({ message: "请拍摄或选择现场签到照片" });
    const evidence = await saveEvidenceFile(part, task.id, user.id, "CHECK_IN");
    task.evidenceFiles = [...(task.evidenceFiles ?? []), evidence];
    task.checkIn = {
      ...input,
      channel: String(request.headers["x-client-channel"] ?? "WEB"),
      checkedAt: new Date().toISOString(),
    };
    store.log(user.id, "PHOTO_SITE_CHECKED_IN", "TASK", task.id, {
      ...task.checkIn,
      evidenceId: evidence.id,
      fileName: evidence.fileName,
      size: evidence.size,
      sha256: evidence.sha256,
    });
    await store.persist();
    return taskDetail(task);
  });

  app.post("/tasks/:taskId/evidence", async (request, reply) => {
    const user = requireUser(request, reply, ["SAMPLER"]);
    if (!user) return;
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) return reply.code(404).send({ message: "任务不存在" });
    if (task.assigneeId !== user.id) return reply.code(403).send({ message: "不能操作其他抽样员的任务" });
    if (!task.checkIn) return reply.code(409).send({ message: "请先完成现场签到再上传照片" });
    const part = await request.file();
    if (!part) return reply.code(400).send({ message: "请选择现场照片" });
    const evidence = await saveEvidenceFile(part, task.id, user.id, "INSPECTION");
    task.evidenceFiles = [...(task.evidenceFiles ?? []), evidence];
    store.log(user.id, "EVIDENCE_UPLOADED", "TASK", task.id, {
      evidenceId: evidence.id, fileName: evidence.fileName, size: evidence.size, sha256: evidence.sha256,
    });
    await store.persist();
    return reply.code(201).send(evidence);
  });

  app.post("/tasks/:taskId/sample-evidence", async (request, reply) => {
    const user = requireUser(request, reply, ["SAMPLER"]);
    if (!user) return;
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const input = z.object({
      sampleKey: z.string().trim().min(5).max(80),
      latitude: z.coerce.number().min(-90).max(90),
      longitude: z.coerce.number().min(-180).max(180),
      accuracy: z.coerce.number().min(0).max(10000),
      address: z.string().trim().min(1).max(500),
      coordinateSystem: z.enum(["WGS84"]).default("WGS84"),
      mapProvider: z.enum(["BAIDU", "AMAP", "ORDER_ADDRESS"]).default("ORDER_ADDRESS"),
      capturedAt: z.iso.datetime(),
      watermarkText: z.string().min(10).max(1000),
      watermarkVersion: z.string().trim().min(1).max(64).default("CLIENT_CANVAS_V1"),
    }).parse(request.query);
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) return reply.code(404).send({ message: "任务不存在" });
    if (task.assigneeId !== user.id) return reply.code(403).send({ message: "不能操作其他抽样员的任务" });
    if (!["ACCEPTED", "IN_PROGRESS"].includes(task.status)) return reply.code(409).send({ message: "当前任务状态不能上传样品照片" });
    if (!task.physicalSample) return reply.code(409).send({ message: "请先完成托盘—箱—件随机抽样" });
    const validKeys = new Set(task.physicalSample.positions.map((position) => `P${position.palletNo}-B${position.boxNo}-I${position.itemNo}`));
    if (!validKeys.has(input.sampleKey)) return reply.code(400).send({ message: "照片绑定的样品位置不在本次抽样结果中" });
    if (!input.watermarkText.includes(input.sampleKey)) return reply.code(400).send({ message: "图片水印缺少样品位置编号" });
    const existingCount = (task.evidenceFiles ?? []).filter((file) => file.purpose === "SAMPLE" && file.sampleKey === input.sampleKey).length;
    if (existingCount >= 5) return reply.code(409).send({ message: "每个抽样样品最多保存5张照片" });
    const part = await request.file();
    if (!part) return reply.code(400).send({ message: "请选择抽样样品照片" });
    const evidence = await saveEvidenceFile(part, task.id, user.id, "SAMPLE", input);
    task.evidenceFiles = [...(task.evidenceFiles ?? []), evidence];
    store.log(user.id, "SAMPLE_EVIDENCE_UPLOADED", "TASK", task.id, {
      evidenceId: evidence.id, sampleKey: evidence.sampleKey, fileName: evidence.fileName,
      latitude: evidence.latitude, longitude: evidence.longitude, address: evidence.address,
      mapProvider: evidence.mapProvider, watermarkVersion: evidence.watermarkVersion, size: evidence.size, sha256: evidence.sha256,
    });
    await store.persist();
    return reply.code(201).send(evidence);
  });

  app.get("/evidence/:evidenceId", async (request, reply) => {
    const user = requireUser(request, reply, ["ADMIN", "REVIEWER", "SAMPLER"]);
    if (!user) return;
    const { evidenceId } = z.object({ evidenceId: z.string().min(1) }).parse(request.params);
    const task = store.tasks.find((item) => item.evidenceFiles?.some((file) => file.id === evidenceId));
    const evidence = task?.evidenceFiles?.find((file) => file.id === evidenceId);
    if (!task || !evidence) return reply.code(404).send({ message: "现场照片不存在" });
    if (!canReadTask(user, task)) return reply.code(403).send({ message: "没有查看该照片的权限" });
    reply.type(evidence.mimeType).header("Content-Disposition", `inline; filename="evidence-${evidence.id}"`);
    return reply.send(openEvidenceFile(evidence.storageKey));
  });

  app.put("/tasks/:taskId/inspection-results", async (request, reply) => {
    const user = requireUser(request, reply, ["SAMPLER"]);
    if (!user) return;
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const input = z.object({ results: z.array(z.object({
      sampleKey: z.string().min(5).max(80),
      conclusion: z.enum(["PASS", "FAIL", "NA"]),
      note: z.string().trim().max(500).default(""),
    })).min(1).max(10000) }).parse(request.body);
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) return reply.code(404).send({ message: "任务不存在" });
    if (task.assigneeId !== user.id) return reply.code(403).send({ message: "不能操作其他抽样员的任务" });
    if (!task.physicalSample) return reply.code(409).send({ message: "请先完成托盘—箱—件随机抽样" });
    const validKeys = new Set(task.physicalSample.positions.map((position) => `P${position.palletNo}-B${position.boxNo}-I${position.itemNo}`));
    if (input.results.some((result) => !validKeys.has(result.sampleKey))) {
      return reply.code(400).send({ message: "检测结果包含不在抽样范围内的位置" });
    }
    const existing = new Map((task.inspectionResults ?? []).map((result) => [result.sampleKey, result]));
    const updatedAt = new Date().toISOString();
    input.results.forEach((result) => existing.set(result.sampleKey, { ...result, updatedAt }));
    task.inspectionResults = [...existing.values()];
    store.log(user.id, "INSPECTION_RESULTS_SAVED", "TASK", task.id, { resultCount: input.results.length });
    await store.persist();
    return taskDetail(task);
  });

  app.post("/tasks/:taskId/submit-review", async (request, reply) => {
    const user = requireUser(request, reply, ["SAMPLER"]);
    if (!user) return;
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) return reply.code(404).send({ message: "任务不存在" });
    if (task.assigneeId !== user.id) return reply.code(403).send({ message: "不能提交其他抽样员的任务" });
    if (!task.checkIn) return reply.code(409).send({ message: "尚未完成现场签到" });
    if (!task.physicalSample) return reply.code(409).send({ message: "尚未完成托盘—箱—件随机抽样" });
    if (!(task.evidenceFiles ?? []).some((file) => file.purpose === "CHECK_IN")) return reply.code(409).send({ message: "尚未完成图片签到" });
    const requiredKeys = task.physicalSample.positions.map((position) => `P${position.palletNo}-B${position.boxNo}-I${position.itemNo}`);
    const photographedKeys = new Set((task.evidenceFiles ?? []).filter((file) => file.purpose === "SAMPLE" && file.sampleKey).map((file) => file.sampleKey));
    const missingPhotoKeys = requiredKeys.filter((key) => !photographedKeys.has(key));
    if (missingPhotoKeys.length > 0) return reply.code(409).send({ message: `每个抽样样品至少需要1张带位置水印的照片，缺少：${missingPhotoKeys.join("、")}` });
    const completedKeys = new Set((task.inspectionResults ?? []).map((result) => result.sampleKey));
    if (requiredKeys.some((key) => !completedKeys.has(key))) return reply.code(409).send({ message: "请填写所有抽样位置的检测结果" });
    task.status = "PENDING_REVIEW";
    task.submittedAt = new Date().toISOString();
    store.log(user.id, "TASK_SUBMITTED_FOR_REVIEW", "TASK", task.id, {
      resultCount: task.inspectionResults?.length ?? 0, evidenceCount: task.evidenceFiles?.length ?? 0,
    });
    await store.persist();
    return taskDetail(task);
  });

  app.post("/tasks/:taskId/review", async (request, reply) => {
    const user = requireUser(request, reply, ["ADMIN", "REVIEWER"]);
    if (!user) return;
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const input = z.object({ decision: z.enum(["APPROVE", "RETURN"]), comment: z.string().trim().min(2).max(500) }).parse(request.body);
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) return reply.code(404).send({ message: "任务不存在" });
    if (task.status !== "PENDING_REVIEW") return reply.code(409).send({ message: "当前任务不在待审核状态" });
    task.reviewRecords = [...(task.reviewRecords ?? []), {
      id: randomUUID(), reviewerId: user.id, reviewerName: user.name,
      decision: input.decision, comment: input.comment, reviewedAt: new Date().toISOString(),
    }];
    if (input.decision === "APPROVE") {
      task.status = "COMPLETED";
      const assignee = store.users.find((item) => item.id === task.assigneeId);
      if (assignee) assignee.activeTaskCount = Math.max(0, assignee.activeTaskCount - 1);
    } else {
      task.status = "IN_PROGRESS";
    }
    store.log(user.id, input.decision === "APPROVE" ? "TASK_REVIEW_APPROVED" : "TASK_REVIEW_RETURNED", "TASK", task.id, { comment: input.comment });
    await store.persist();
    return taskDetail(task);
  });
}
