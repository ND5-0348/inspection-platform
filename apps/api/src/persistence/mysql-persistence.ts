import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import mysql, { type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import type {
  AuditLog, EvidenceFile, InspectionOrder, InspectionResult, InspectionTask, PhysicalSamplePosition,
  RandomAudit, ReviewRecord, SiteCheckIn, User,
} from "../domain/types.js";
import type { MemoryStore, StorePersistence } from "../store/memory-store.js";

type DbRow = RowDataPacket & Record<string, any>;

function asDate(value?: string): Date | null { return value ? new Date(value) : null; }
function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}
function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString("utf8")) as T;
  return value as T;
}
function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 33)}`;
}

export interface MySqlPersistenceInfo {
  database: string;
  host: string;
  port: number;
}

class MySqlPersistence implements StorePersistence {
  constructor(private readonly pool: Pool) {}

  async close(): Promise<void> { await this.pool.end(); }

  async deleteOrder(orderId: string): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("DELETE FROM order_items WHERE order_id = ?", [orderId]);
      await connection.execute("DELETE FROM inspection_orders WHERE id = ?", [orderId]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async syncStore(store: MemoryStore): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const user of store.users) await this.saveUser(connection, user, store);
      for (const order of store.orders) await this.saveOrder(connection, order);
      for (const task of store.tasks) await this.saveTask(connection, task);
      for (const audit of store.randomAudits) await this.saveRandomAudit(connection, audit);
      for (const log of store.auditLogs) await this.saveAuditLog(connection, log);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async saveUser(connection: PoolConnection, user: User, store: MemoryStore) {
    const credential = store.credentialForUser(user.id);
    await connection.execute(
      `INSERT INTO users (id, employee_no, name, mobile, department, role, status, password_hash, password_salt, qualifications, active_task_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE employee_no=VALUES(employee_no), name=VALUES(name), mobile=VALUES(mobile),
       department=VALUES(department), role=VALUES(role), status=VALUES(status), password_hash=VALUES(password_hash),
       password_salt=VALUES(password_salt), qualifications=VALUES(qualifications),
       active_task_count=VALUES(active_task_count)`,
      [user.id, user.employeeNo, user.name, user.mobile, user.department, user.role, user.status,
        credential?.digestHex ?? null, credential?.salt ?? null, JSON.stringify(user.qualifications), user.activeTaskCount],
    );
  }

  private async saveOrder(connection: PoolConnection, order: InspectionOrder) {
    await connection.execute(
      `INSERT INTO inspection_orders (id, order_no, customer_name, site_address, product_category, planned_at, status,
       inspection_type, receiving_unit, supplier_name, contact_name, contact_phone, source_status, source_sampler,
       source_remarks, import_source, imported_at, item_list_version, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'usr-admin', ?)
       ON DUPLICATE KEY UPDATE customer_name=VALUES(customer_name), site_address=VALUES(site_address),
       product_category=VALUES(product_category), planned_at=VALUES(planned_at), status=VALUES(status),
       inspection_type=VALUES(inspection_type), receiving_unit=VALUES(receiving_unit), supplier_name=VALUES(supplier_name),
       contact_name=VALUES(contact_name), contact_phone=VALUES(contact_phone), source_status=VALUES(source_status),
       source_sampler=VALUES(source_sampler), source_remarks=VALUES(source_remarks), import_source=VALUES(import_source), imported_at=VALUES(imported_at)`,
      [order.id, order.orderNo, order.customerName, order.siteAddress, order.productCategory, asDate(order.plannedAt), order.status,
        order.inspectionType ?? null, order.receivingUnit ?? null, order.supplierName ?? null, order.contactName ?? null,
        order.contactPhone ?? null, order.sourceStatus ?? null, order.sourceSampler ?? null, order.sourceRemarks ?? null,
        order.importSource ?? null, asDate(order.importedAt), asDate(order.createdAt)],
    );
    for (const item of order.items) {
      await connection.execute(
        `INSERT INTO order_items (id, order_id, list_version, product_code, product_name, batch_no, quantity,
         order_line_id, specification, sample_quantity, completed_sample_quantity, source_sampler, source_status, remark)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE product_code=VALUES(product_code), product_name=VALUES(product_name), batch_no=VALUES(batch_no),
         quantity=VALUES(quantity), order_line_id=VALUES(order_line_id), specification=VALUES(specification),
         sample_quantity=VALUES(sample_quantity), completed_sample_quantity=VALUES(completed_sample_quantity),
         source_sampler=VALUES(source_sampler), source_status=VALUES(source_status), remark=VALUES(remark)`,
        [item.id, order.id, item.productCode, item.productName, item.batchNo, item.quantity, item.orderLineId ?? null,
          item.specification ?? null, item.sampleQuantity ?? null, item.completedSampleQuantity ?? null,
          item.sourceSampler ?? null, item.sourceStatus ?? null, item.remark ?? null],
      );
    }
  }

  private async saveTask(connection: PoolConnection, task: InspectionTask) {
    const latestReview = task.reviewRecords?.at(-1);
    await connection.execute(
      `INSERT INTO inspection_tasks (id, task_no, order_id, assignee_id, status, assigned_at, accepted_at, submitted_at, completed_at, sample_item_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE assignee_id=VALUES(assignee_id), status=VALUES(status), assigned_at=VALUES(assigned_at),
       accepted_at=VALUES(accepted_at), submitted_at=VALUES(submitted_at), completed_at=VALUES(completed_at), sample_item_ids=VALUES(sample_item_ids)`,
      [task.id, task.taskNo, task.orderId, task.assigneeId, task.status, asDate(task.assignedAt), asDate(task.acceptedAt),
        asDate(task.submittedAt), task.status === "COMPLETED" ? asDate(latestReview?.reviewedAt) : null, JSON.stringify(task.sampleItemIds)],
    );

    if (task.checkIn) await this.saveCheckIn(connection, task.id, task.checkIn);
    if (task.physicalSample) {
      const sample = task.physicalSample;
      await connection.execute(
        `INSERT INTO physical_sample_records (id, task_id, order_item_id, pallet_count, boxes_per_pallet, items_per_box, sample_count,
         candidate_total, candidate_hash, rule_version, positions, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE order_item_id=VALUES(order_item_id), pallet_count=VALUES(pallet_count), boxes_per_pallet=VALUES(boxes_per_pallet),
         items_per_box=VALUES(items_per_box), sample_count=VALUES(sample_count), candidate_total=VALUES(candidate_total),
         candidate_hash=VALUES(candidate_hash), rule_version=VALUES(rule_version), positions=VALUES(positions)`,
        [sample.id, task.id, sample.orderItemId, sample.palletCount, sample.boxesPerPallet, sample.itemsPerBox, sample.sampleCount,
          sample.candidateTotal, sample.candidateHash, sample.ruleVersion, JSON.stringify(sample.positions), sample.createdBy, asDate(sample.createdAt)],
      );
    }
    for (const evidence of task.evidenceFiles ?? []) await this.saveEvidence(connection, evidence);
    for (const result of task.inspectionResults ?? []) await this.saveInspectionResult(connection, task.id, result);
    for (const review of task.reviewRecords ?? []) await this.saveReview(connection, task.id, review);
  }

  private async saveCheckIn(connection: PoolConnection, taskId: string, checkIn: SiteCheckIn) {
    await connection.execute(
      `INSERT INTO site_check_ins (id, task_id, latitude, longitude, accuracy, address, client_channel, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE latitude=VALUES(latitude), longitude=VALUES(longitude), accuracy=VALUES(accuracy),
       address=VALUES(address), client_channel=VALUES(client_channel), checked_at=VALUES(checked_at)`,
      [stableId("ci", taskId), taskId, checkIn.latitude, checkIn.longitude, checkIn.accuracy, checkIn.address ?? null, checkIn.channel, asDate(checkIn.checkedAt)],
    );
  }

  private async saveEvidence(connection: PoolConnection, evidence: EvidenceFile) {
    await connection.execute(
      `INSERT INTO evidence_files (id, task_id, purpose, sample_key, file_name, mime_type, file_size, storage_key, sha256,
       latitude, longitude, accuracy, address, coordinate_system, map_provider, captured_at, watermark_text, watermark_version, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE purpose=VALUES(purpose), sample_key=VALUES(sample_key), file_name=VALUES(file_name),
       mime_type=VALUES(mime_type), file_size=VALUES(file_size), storage_key=VALUES(storage_key), sha256=VALUES(sha256),
       latitude=VALUES(latitude), longitude=VALUES(longitude), accuracy=VALUES(accuracy), address=VALUES(address),
       coordinate_system=VALUES(coordinate_system), map_provider=VALUES(map_provider), captured_at=VALUES(captured_at),
       watermark_text=VALUES(watermark_text), watermark_version=VALUES(watermark_version)`,
      [evidence.id, evidence.taskId, evidence.purpose, evidence.sampleKey ?? null, evidence.fileName, evidence.mimeType,
        evidence.size, evidence.storageKey, evidence.sha256, evidence.latitude ?? null, evidence.longitude ?? null,
        evidence.accuracy ?? null, evidence.address ?? null, evidence.coordinateSystem ?? null, evidence.mapProvider ?? null,
        asDate(evidence.capturedAt), evidence.watermarkText ?? null, evidence.watermarkVersion ?? null,
        evidence.uploadedBy, asDate(evidence.uploadedAt)],
    );
  }

  private async saveInspectionResult(connection: PoolConnection, taskId: string, result: InspectionResult) {
    await connection.execute(
      `INSERT INTO inspection_results (id, task_id, sample_key, conclusion, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE conclusion=VALUES(conclusion), note=VALUES(note), updated_at=VALUES(updated_at)`,
      [stableId("rs", `${taskId}|${result.sampleKey}`), taskId, result.sampleKey, result.conclusion, result.note, asDate(result.updatedAt)],
    );
  }

  private async saveReview(connection: PoolConnection, taskId: string, review: ReviewRecord) {
    await connection.execute(
      `INSERT INTO review_records (id, task_id, reviewer_id, decision, comment, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE decision=VALUES(decision), comment=VALUES(comment), reviewed_at=VALUES(reviewed_at)`,
      [review.id, taskId, review.reviewerId, review.decision, review.comment, asDate(review.reviewedAt)],
    );
  }

  private async saveRandomAudit(connection: PoolConnection, audit: RandomAudit) {
    await connection.execute(
      `INSERT INTO random_audits (id, draw_type, subject_id, rule_version, candidate_hash, candidate_count, selected_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rule_version=VALUES(rule_version), candidate_hash=VALUES(candidate_hash),
       candidate_count=VALUES(candidate_count), selected_ids=VALUES(selected_ids)`,
      [audit.id, audit.type, audit.subjectId, audit.ruleVersion, audit.candidateHash, audit.candidateCount, JSON.stringify(audit.selectedIds), asDate(audit.createdAt)],
    );
  }

  private async saveAuditLog(connection: PoolConnection, log: AuditLog) {
    await connection.execute(
      `INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE detail=VALUES(detail)`,
      [log.id, log.actorId, log.action, log.resourceType, log.resourceId, JSON.stringify(log.detail), asDate(log.createdAt)],
    );
  }

  async loadStore(store: MemoryStore): Promise<boolean> {
    const [userRows] = await this.pool.query<DbRow[]>("SELECT * FROM users ORDER BY created_at, id");
    if (userRows.length === 0) return false;
    store.users = userRows.map((row) => ({
      id: row.id, employeeNo: row.employee_no, name: row.name, mobile: row.mobile, department: row.department,
      role: row.role, status: row.status, qualifications: parseJson<string[]>(row.qualifications, []), activeTaskCount: Number(row.active_task_count),
    }));
    userRows.forEach((row) => {
      if (row.password_hash && row.password_salt) {
        store.hydrateCredential(row.employee_no, { userId: row.id, digestHex: row.password_hash, salt: row.password_salt });
      }
    });

    const [orderRows] = await this.pool.query<DbRow[]>("SELECT * FROM inspection_orders WHERE deleted_at IS NULL ORDER BY created_at DESC");
    const [itemRows] = await this.pool.query<DbRow[]>("SELECT * FROM order_items ORDER BY created_at, id");
    store.orders = orderRows.map((row): InspectionOrder => ({
      id: row.id, orderNo: row.order_no, customerName: row.customer_name, siteAddress: row.site_address,
      productCategory: row.product_category, plannedAt: asIso(row.planned_at), status: row.status, createdAt: asIso(row.created_at),
      inspectionType: row.inspection_type ?? undefined, receivingUnit: row.receiving_unit ?? undefined,
      supplierName: row.supplier_name ?? undefined, contactName: row.contact_name ?? undefined,
      contactPhone: row.contact_phone ?? undefined, sourceStatus: row.source_status ?? undefined,
      sourceSampler: row.source_sampler ?? undefined, sourceRemarks: row.source_remarks ?? undefined,
      importSource: row.import_source ?? undefined, importedAt: row.imported_at ? asIso(row.imported_at) : undefined,
      items: itemRows.filter((item) => item.order_id === row.id).map((item) => ({
        id: item.id, productCode: item.product_code, productName: item.product_name, batchNo: item.batch_no, quantity: Number(item.quantity),
        orderLineId: item.order_line_id ?? undefined, specification: item.specification ?? undefined,
        sampleQuantity: item.sample_quantity === null ? undefined : Number(item.sample_quantity),
        completedSampleQuantity: item.completed_sample_quantity === null ? undefined : Number(item.completed_sample_quantity),
        sourceSampler: item.source_sampler ?? undefined, sourceStatus: item.source_status ?? undefined, remark: item.remark ?? undefined,
      })),
    }));

    const [taskRows] = await this.pool.query<DbRow[]>("SELECT * FROM inspection_tasks ORDER BY created_at DESC");
    store.tasks = taskRows.map((row): InspectionTask => ({
      id: row.id, taskNo: row.task_no, orderId: row.order_id, assigneeId: row.assignee_id,
      assigneeName: store.users.find((user) => user.id === row.assignee_id)?.name ?? "未知人员",
      status: row.status, assignedAt: asIso(row.assigned_at), acceptedAt: row.accepted_at ? asIso(row.accepted_at) : undefined,
      submittedAt: row.submitted_at ? asIso(row.submitted_at) : undefined,
      sampleItemIds: parseJson<string[]>(row.sample_item_ids, []), evidenceFiles: [], inspectionResults: [], reviewRecords: [],
    }));

    await this.loadTaskDetails(store);
    const [randomRows] = await this.pool.query<DbRow[]>("SELECT * FROM random_audits ORDER BY created_at DESC");
    store.randomAudits = randomRows.map((row): RandomAudit => ({
      id: row.id, type: row.draw_type, subjectId: row.subject_id, ruleVersion: row.rule_version,
      candidateHash: row.candidate_hash, candidateCount: Number(row.candidate_count), selectedIds: parseJson<string[]>(row.selected_ids, []), createdAt: asIso(row.created_at),
    }));
    const [logRows] = await this.pool.query<DbRow[]>("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 10000");
    store.auditLogs = logRows.map((row): AuditLog => ({
      id: row.id, actorId: row.actor_id, action: row.action, resourceType: row.resource_type,
      resourceId: row.resource_id, detail: parseJson<Record<string, unknown>>(row.detail, {}), createdAt: asIso(row.created_at),
    }));
    return true;
  }

  private async loadTaskDetails(store: MemoryStore) {
    const [checkInRows] = await this.pool.query<DbRow[]>("SELECT * FROM site_check_ins");
    const [sampleRows] = await this.pool.query<DbRow[]>("SELECT * FROM physical_sample_records");
    const [evidenceRows] = await this.pool.query<DbRow[]>("SELECT * FROM evidence_files ORDER BY uploaded_at");
    const [resultRows] = await this.pool.query<DbRow[]>("SELECT * FROM inspection_results ORDER BY updated_at");
    const [reviewRows] = await this.pool.query<DbRow[]>("SELECT rr.*, u.name AS reviewer_name FROM review_records rr JOIN users u ON u.id=rr.reviewer_id ORDER BY rr.reviewed_at");

    for (const task of store.tasks) {
      const checkIn = checkInRows.find((row) => row.task_id === task.id);
      if (checkIn) task.checkIn = {
        latitude: Number(checkIn.latitude), longitude: Number(checkIn.longitude), accuracy: Number(checkIn.accuracy),
        address: checkIn.address ?? undefined, channel: checkIn.client_channel, checkedAt: asIso(checkIn.checked_at),
      };
      const sample = sampleRows.find((row) => row.task_id === task.id);
      if (sample) {
        const orderItem = store.orders.flatMap((order) => order.items).find((item) => item.id === sample.order_item_id);
        task.physicalSample = {
          id: sample.id, orderItemId: sample.order_item_id, productCode: orderItem?.productCode ?? "",
          productName: orderItem?.productName ?? "", batchNo: orderItem?.batchNo ?? "",
          palletCount: Number(sample.pallet_count), boxesPerPallet: Number(sample.boxes_per_pallet), itemsPerBox: Number(sample.items_per_box),
          sampleCount: Number(sample.sample_count), candidateTotal: Number(sample.candidate_total), candidateHash: sample.candidate_hash,
          ruleVersion: sample.rule_version, positions: parseJson<PhysicalSamplePosition[]>(sample.positions, []),
          createdBy: sample.created_by, createdAt: asIso(sample.created_at),
        };
      }
      task.evidenceFiles = evidenceRows.filter((row) => row.task_id === task.id).map((row): EvidenceFile => ({
        id: row.id, taskId: row.task_id, purpose: row.purpose ?? "INSPECTION", sampleKey: row.sample_key ?? undefined,
        fileName: row.file_name, mimeType: row.mime_type, size: Number(row.file_size), storageKey: row.storage_key,
        sha256: row.sha256, latitude: row.latitude === null ? undefined : Number(row.latitude),
        longitude: row.longitude === null ? undefined : Number(row.longitude), accuracy: row.accuracy === null ? undefined : Number(row.accuracy),
        address: row.address ?? undefined, coordinateSystem: row.coordinate_system ?? undefined, mapProvider: row.map_provider ?? undefined,
        capturedAt: row.captured_at ? asIso(row.captured_at) : undefined, watermarkText: row.watermark_text ?? undefined,
        watermarkVersion: row.watermark_version ?? undefined, uploadedBy: row.uploaded_by, uploadedAt: asIso(row.uploaded_at),
      }));
      task.inspectionResults = resultRows.filter((row) => row.task_id === task.id).map((row): InspectionResult => ({
        sampleKey: row.sample_key, conclusion: row.conclusion, note: row.note, updatedAt: asIso(row.updated_at),
      }));
      task.reviewRecords = reviewRows.filter((row) => row.task_id === task.id).map((row): ReviewRecord => ({
        id: row.id, reviewerId: row.reviewer_id, reviewerName: row.reviewer_name, decision: row.decision,
        comment: row.comment, reviewedAt: asIso(row.reviewed_at),
      }));
    }
  }
}

function resolveMigrationFile(): string {
  const candidates = [
    process.env.MIGRATION_FILE,
    join(process.cwd(), "database", "001_initial_schema.sql"),
    join(process.cwd(), "..", "..", "database", "001_initial_schema.sql"),
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find(existsSync);
  if (!found) throw new Error("找不到MySQL初始化脚本 database/001_initial_schema.sql");
  return found;
}

async function ensureColumn(pool: Pool, database: string, table: string, column: string, definition: string): Promise<void> {
  const [rows] = await pool.query<DbRow[]>(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1",
    [database, table, column],
  );
  if (rows.length === 0) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

async function ensureWeeklyPlanColumns(pool: Pool, database: string): Promise<void> {
  const columns: Array<[string, string, string]> = [
    ["inspection_orders", "inspection_type", "VARCHAR(80) NULL"],
    ["inspection_orders", "receiving_unit", "VARCHAR(160) NULL"],
    ["inspection_orders", "supplier_name", "VARCHAR(160) NULL"],
    ["inspection_orders", "contact_name", "VARCHAR(80) NULL"],
    ["inspection_orders", "contact_phone", "VARCHAR(32) NULL"],
    ["inspection_orders", "source_status", "VARCHAR(64) NULL"],
    ["inspection_orders", "source_sampler", "VARCHAR(120) NULL"],
    ["inspection_orders", "source_remarks", "VARCHAR(500) NULL"],
    ["inspection_orders", "import_source", "VARCHAR(255) NULL"],
    ["inspection_orders", "imported_at", "DATETIME(3) NULL"],
    ["order_items", "order_line_id", "VARCHAR(64) NULL"],
    ["order_items", "specification", "VARCHAR(255) NULL"],
    ["order_items", "sample_quantity", "INT NULL"],
    ["order_items", "completed_sample_quantity", "INT NULL"],
    ["order_items", "source_sampler", "VARCHAR(120) NULL"],
    ["order_items", "source_status", "VARCHAR(64) NULL"],
    ["order_items", "remark", "VARCHAR(500) NULL"],
  ];
  for (const [table, column, definition] of columns) await ensureColumn(pool, database, table, column, definition);
}

async function ensurePhotoCheckInColumns(pool: Pool, database: string): Promise<void> {
  const columns: Array<[string, string]> = [
    ["purpose", "VARCHAR(32) NOT NULL DEFAULT 'INSPECTION'"],
    ["sample_key", "VARCHAR(80) NULL"],
    ["latitude", "DECIMAL(10,7) NULL"],
    ["longitude", "DECIMAL(10,7) NULL"],
    ["accuracy", "DECIMAL(10,2) NULL"],
    ["address", "VARCHAR(500) NULL"],
    ["coordinate_system", "VARCHAR(32) NULL"],
    ["map_provider", "VARCHAR(32) NULL"],
    ["captured_at", "DATETIME(3) NULL"],
    ["watermark_text", "VARCHAR(1000) NULL"],
    ["watermark_version", "VARCHAR(64) NULL"],
  ];
  for (const [column, definition] of columns) await ensureColumn(pool, database, "evidence_files", column, definition);
}

export async function initializeMySqlPersistence(store: MemoryStore, databaseUrl: string): Promise<MySqlPersistenceInfo> {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error("MySQL数据库名称不合法");
  const config = {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };

  const bootstrap = await mysql.createConnection({ ...config, timezone: "Z" });
  await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await bootstrap.end();

  const pool = mysql.createPool({ ...config, database, timezone: "Z", connectionLimit: 8, multipleStatements: true });
  const schema = await readFile(resolveMigrationFile(), "utf8");
  await pool.query(schema);
  await ensureWeeklyPlanColumns(pool, database);
  await ensurePhotoCheckInColumns(pool, database);
  const persistence = new MySqlPersistence(pool);
  const loaded = await persistence.loadStore(store);
  store.attachPersistence(persistence);
  await store.persist();
  return { database, host: config.host, port: config.port };
}
