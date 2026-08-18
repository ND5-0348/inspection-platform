import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { AuditLog, AuthSession, InspectionOrder, InspectionTask, RandomAudit, User } from "../domain/types.js";

const now = () => new Date().toISOString();
const passwordDigest = (password: string, salt: string) => scryptSync(password, salt, 32).toString("hex");

export interface PasswordCredential {
  userId: string;
  digestHex: string;
  salt: string;
}

export interface StorePersistence {
  syncStore(store: MemoryStore): Promise<void>;
  deleteOrder(orderId: string): Promise<void>;
  close(): Promise<void>;
}

export class MemoryStore {
  private persistence?: StorePersistence;
  users: User[] = [
    { id: "usr-admin", employeeNo: "A001", name: "系统管理员", mobile: "138****0001", department: "质量管理部", role: "ADMIN", status: "ACTIVE", qualifications: [], activeTaskCount: 0 },
    { id: "usr-sampler-1", employeeNo: "S001", name: "林晓峰", mobile: "138****1001", department: "华东检测组", role: "SAMPLER", status: "ACTIVE", qualifications: ["电气设备", "通用产品"], activeTaskCount: 1 },
    { id: "usr-sampler-2", employeeNo: "S002", name: "周雨晴", mobile: "138****1002", department: "华东检测组", role: "SAMPLER", status: "ACTIVE", qualifications: ["电气设备", "通用产品"], activeTaskCount: 0 },
    { id: "usr-sampler-3", employeeNo: "S003", name: "陈志远", mobile: "138****1003", department: "华南检测组", role: "SAMPLER", status: "ON_LEAVE", qualifications: ["通用产品"], activeTaskCount: 0 }
  ];

  orders: InspectionOrder[] = [
    {
      id: "ord-demo-1",
      orderNo: "JC-20260814-001",
      customerName: "上海示范制造有限公司",
      siteAddress: "上海市浦东新区示范路88号",
      productCategory: "电气设备",
      plannedAt: "2026-08-18T01:00:00.000Z",
      status: "PENDING_DISPATCH",
      createdAt: now(),
      items: [
        { id: "item-1", productCode: "DQ-001", productName: "低压配电柜A", batchNo: "B20260801", quantity: 12 },
        { id: "item-2", productCode: "DQ-002", productName: "低压配电柜B", batchNo: "B20260801", quantity: 8 },
        { id: "item-3", productCode: "DQ-003", productName: "控制箱", batchNo: "B20260802", quantity: 20 }
      ]
    },
    {
      id: "ord-demo-2",
      orderNo: "JC-20260814-002",
      customerName: "苏州远行机电有限公司",
      siteAddress: "江苏省苏州市工业园区星港街56号",
      productCategory: "电气设备",
      plannedAt: "2026-08-19T02:00:00.000Z",
      status: "DISPATCHED",
      createdAt: now(),
      items: [
        { id: "item-4", productCode: "JD-101", productName: "动力控制柜", batchNo: "SZ202608-A", quantity: 10 },
        { id: "item-5", productCode: "JD-102", productName: "变频控制柜", batchNo: "SZ202608-A", quantity: 6 },
        { id: "item-6", productCode: "JD-103", productName: "现场操作箱", batchNo: "SZ202608-B", quantity: 18 }
      ]
    }
  ];

  tasks: InspectionTask[] = [{
    id: "task-demo-1",
    taskNo: "RW-20260814-002",
    orderId: "ord-demo-2",
    assigneeId: "usr-sampler-1",
    assigneeName: "林晓峰",
    status: "PENDING_ACCEPTANCE",
    assignedAt: now(),
    sampleItemIds: [],
  }];
  randomAudits: RandomAudit[] = [];
  auditLogs: AuditLog[] = [];
  sessions = new Map<string, { userId: string; expiresAt: number }>();

  private credentials = new Map<string, PasswordCredential>();

  constructor() {
    this.setPassword("A001", "usr-admin", "Admin@123");
    this.setPassword("S001", "usr-sampler-1", "Sampler@123");
    this.setPassword("S002", "usr-sampler-2", "Sampler@123");
  }

  private setPassword(employeeNo: string, userId: string, password: string): void {
    const salt = randomBytes(16).toString("hex");
    this.credentials.set(employeeNo.toUpperCase(), { userId, salt, digestHex: passwordDigest(password, salt) });
  }

  credentialForUser(userId: string): PasswordCredential | undefined {
    return [...this.credentials.values()].find((credential) => credential.userId === userId);
  }

  hydrateCredential(employeeNo: string, credential: PasswordCredential): void {
    this.credentials.set(employeeNo.toUpperCase(), credential);
  }

  createSampler(input: Pick<User, "employeeNo" | "name" | "mobile" | "department" | "qualifications">, initialPassword: string, actorId: string): User {
    const user: User = {
      ...input,
      id: randomUUID(),
      employeeNo: input.employeeNo.toUpperCase(),
      role: "SAMPLER",
      status: "ACTIVE",
      activeTaskCount: 0,
    };
    this.users.push(user);
    this.setPassword(user.employeeNo, user.id, initialPassword);
    this.log(actorId, "SAMPLER_ACCOUNT_CREATED", "USER", user.id, { employeeNo: user.employeeNo, name: user.name });
    return user;
  }

  resetSamplerPassword(user: User, newPassword: string, actorId: string): void {
    this.setPassword(user.employeeNo, user.id, newPassword);
    this.sessions.forEach((session, token) => {
      if (session.userId === user.id) this.sessions.delete(token);
    });
    this.log(actorId, "SAMPLER_PASSWORD_INITIALIZED", "USER", user.id, { employeeNo: user.employeeNo });
  }

  deactivateSampler(user: User, actorId: string): void {
    user.status = "INACTIVE";
    this.sessions.forEach((session, token) => {
      if (session.userId === user.id) this.sessions.delete(token);
    });
    this.log(actorId, "SAMPLER_ACCOUNT_DEACTIVATED", "USER", user.id, { employeeNo: user.employeeNo });
  }

  setSamplerStatus(user: User, status: "ACTIVE" | "ON_LEAVE", actorId: string): void {
    const previousStatus = user.status;
    user.status = status;
    if (status !== "ACTIVE") {
      this.sessions.forEach((session, token) => {
        if (session.userId === user.id) this.sessions.delete(token);
      });
    }
    this.log(actorId, "SAMPLER_STATUS_CHANGED", "USER", user.id, {
      employeeNo: user.employeeNo, previousStatus, status,
    });
  }

  createOrder(input: Omit<InspectionOrder, "id" | "createdAt" | "status">, actorId: string): InspectionOrder {
    if (this.orders.some((order) => order.orderNo === input.orderNo)) throw new Error("检测单号已存在");
    const order: InspectionOrder = { ...input, id: randomUUID(), createdAt: now(), status: "PENDING_DISPATCH" };
    this.orders.unshift(order);
    this.log(actorId, "ORDER_CREATED", "ORDER", order.id, { orderNo: order.orderNo });
    return order;
  }

  async deleteOrder(order: InspectionOrder, actorId: string): Promise<void> {
    await this.persistence?.deleteOrder(order.id);
    this.orders = this.orders.filter((item) => item.id !== order.id);
    this.log(actorId, "ORDER_DELETED", "ORDER", order.id, { orderNo: order.orderNo });
  }

  login(employeeNo: string, password: string): AuthSession | undefined {
    const credential = this.credentials.get(employeeNo.toUpperCase());
    if (!credential) return undefined;
    const supplied = Buffer.from(passwordDigest(password, credential.salt), "hex");
    const expected = Buffer.from(credential.digestHex, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) return undefined;
    const user = this.users.find((item) => item.id === credential.userId && item.status === "ACTIVE");
    if (!user) return undefined;
    const token = randomUUID();
    const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
    this.sessions.set(token, { userId: user.id, expiresAt });
    this.log(user.id, "USER_LOGGED_IN", "USER", user.id, { channel: "PASSWORD" });
    return { token, user, expiresAt: new Date(expiresAt).toISOString() };
  }

  userForToken(token: string): User | undefined {
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return this.users.find((user) => user.id === session.userId && user.status === "ACTIVE");
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }

  attachPersistence(persistence: StorePersistence): void {
    this.persistence = persistence;
  }

  async persist(): Promise<void> {
    await this.persistence?.syncStore(this);
  }

  async closePersistence(): Promise<void> {
    await this.persistence?.close();
  }

  log(actorId: string, action: string, resourceType: string, resourceId: string, detail: Record<string, unknown>): void {
    this.auditLogs.unshift({ id: randomUUID(), actorId, action, resourceType, resourceId, detail, createdAt: now() });
  }
}

export const store = new MemoryStore();
