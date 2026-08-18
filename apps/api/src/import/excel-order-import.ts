import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import type { InspectionOrder, OrderItem } from "../domain/types.js";

export const WEEKLY_PLAN_HEADERS = [
  "序号", "质检类型", "抽样采购订单号", "订单行项ID", "计划抽检日期", "收货单位", "供应商名称", "物资编码", "物资名称",
  "规格型号", "抽样样品数", "抽样人员", "完成样品数", "检查状态", "联系人", "收货人电话", "收货地址", "备注",
] as const;

interface WeeklyPlanRow {
  sheetName: string;
  rowNumber: number;
  sequence: string;
  inspectionType: string;
  orderNo: string;
  orderLineId: string;
  plannedDate: string;
  receivingUnit: string;
  supplierName: string;
  productCode: string;
  productName: string;
  specification: string;
  sampleQuantity: number;
  sourceSampler: string;
  completedSampleQuantity: number;
  sourceStatus: string;
  contactName: string;
  contactPhone: string;
  receivingAddress: string;
  remark: string;
}

export interface ExcelOrderImportResult {
  orders: Array<Omit<InspectionOrder, "id" | "createdAt" | "status">>;
  sheetCount: number;
  rowCount: number;
  itemCount: number;
}

class ExcelImportError extends Error {
  statusCode = 400;
}

function cellText(cell: ExcelJS.Cell, identifier = false): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    if (identifier) return Number.isSafeInteger(value) ? String(value) : cell.text.trim();
    return String(value);
  }
  if (typeof value === "object") return cell.text.trim();
  return String(value).trim();
}

function required(value: string, row: WeeklyPlanRow, field: string): string {
  if (!value) throw new ExcelImportError(`${row.sheetName} 第${row.rowNumber}行“${field}”不能为空`);
  return value;
}

function nonNegativeInteger(value: string, row: WeeklyPlanRow, field: string, requiredValue = false): number {
  if (!value && !requiredValue) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (requiredValue ? 1 : 0)) {
    throw new ExcelImportError(`${row.sheetName} 第${row.rowNumber}行“${field}”必须是${requiredValue ? "正" : "非负"}整数`);
  }
  return parsed;
}

function plannedAt(value: string, row: WeeklyPlanRow): string {
  const normalized = value.trim().replace(/\//g, "-");
  const dateOnly = /^\d{4}-\d{1,2}-\d{1,2}$/.test(normalized)
    ? normalized.split("-").map((part, index) => index === 0 ? part : part.padStart(2, "0")).join("-")
    : "";
  const date = new Date(dateOnly ? `${dateOnly}T09:00:00+08:00` : normalized);
  if (Number.isNaN(date.getTime())) throw new ExcelImportError(`${row.sheetName} 第${row.rowNumber}行“计划抽检日期”格式不正确`);
  return date.toISOString();
}

function joined(values: Iterable<string>): string {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].join("、");
}

export async function parseWeeklyPlanWorkbook(buffer: Buffer, fileName: string): Promise<ExcelOrderImportResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const rows: WeeklyPlanRow[] = [];
  let nonEmptySheetCount = 0;

  workbook.eachSheet((sheet) => {
    if (sheet.actualRowCount === 0) return;
    const headers = WEEKLY_PLAN_HEADERS.map((_, index) => cellText(sheet.getRow(1).getCell(index + 1)));
    const mismatch = WEEKLY_PLAN_HEADERS.findIndex((header, index) => headers[index] !== header);
    if (mismatch >= 0) {
      throw new ExcelImportError(`${sheet.name} 第${mismatch + 1}列表头应为“${WEEKLY_PLAN_HEADERS[mismatch]}”，实际为“${headers[mismatch] || "空"}”`);
    }
    nonEmptySheetCount += 1;
    for (let rowNumber = 2; rowNumber <= sheet.actualRowCount; rowNumber += 1) {
      const excelRow = sheet.getRow(rowNumber);
      const values = WEEKLY_PLAN_HEADERS.map((_, index) => cellText(excelRow.getCell(index + 1), [0, 2, 3, 7, 15].includes(index)));
      if (values.every((value) => !value)) continue;
      const value = (index: number) => values[index] ?? "";
      const row: WeeklyPlanRow = {
        sheetName: sheet.name, rowNumber,
        sequence: value(0), inspectionType: value(1), orderNo: value(2), orderLineId: value(3), plannedDate: value(4),
        receivingUnit: value(5), supplierName: value(6), productCode: value(7), productName: value(8), specification: value(9),
        sampleQuantity: 0, sourceSampler: value(11), completedSampleQuantity: 0, sourceStatus: value(13), contactName: value(14),
        contactPhone: value(15), receivingAddress: value(16), remark: value(17),
      };
      required(row.orderNo, row, "抽样采购订单号");
      required(row.orderLineId, row, "订单行项ID");
      required(row.plannedDate, row, "计划抽检日期");
      required(row.receivingUnit, row, "收货单位");
      required(row.supplierName, row, "供应商名称");
      required(row.productCode, row, "物资编码");
      required(row.productName, row, "物资名称");
      required(row.receivingAddress, row, "收货地址");
      row.sampleQuantity = nonNegativeInteger(value(10), row, "抽样样品数", true);
      row.completedSampleQuantity = nonNegativeInteger(value(12), row, "完成样品数");
      plannedAt(row.plannedDate, row);
      rows.push(row);
    }
  });

  if (rows.length === 0) throw new ExcelImportError("Excel中没有可导入的数据行");
  const grouped = new Map<string, WeeklyPlanRow[]>();
  rows.forEach((row) => grouped.set(row.orderNo, [...(grouped.get(row.orderNo) ?? []), row]));
  const orders = [...grouped.entries()].map(([orderNo, orderRows]) => {
    const itemGroups = new Map<string, WeeklyPlanRow[]>();
    orderRows.forEach((row) => {
      const key = `${row.orderLineId}|${row.productCode}`;
      itemGroups.set(key, [...(itemGroups.get(key) ?? []), row]);
    });
    const items: OrderItem[] = [...itemGroups.values()].map((itemRows) => {
      const first = itemRows[0]!;
      const sampleQuantity = itemRows.reduce((total, row) => total + row.sampleQuantity, 0);
      return {
        id: randomUUID(), productCode: first.productCode, productName: first.productName,
        batchNo: first.orderLineId, quantity: sampleQuantity, orderLineId: first.orderLineId,
        specification: joined(itemRows.map((row) => row.specification)) || "-", sampleQuantity,
        completedSampleQuantity: itemRows.reduce((total, row) => total + row.completedSampleQuantity, 0),
        sourceSampler: joined(itemRows.map((row) => row.sourceSampler)), sourceStatus: joined(itemRows.map((row) => row.sourceStatus)),
        remark: joined(itemRows.map((row) => row.remark)),
      };
    });
    return {
      orderNo,
      customerName: joined(orderRows.map((row) => row.receivingUnit)),
      siteAddress: joined(orderRows.map((row) => row.receivingAddress)),
      productCategory: "通用产品",
      plannedAt: plannedAt(orderRows[0]!.plannedDate, orderRows[0]!),
      items,
      inspectionType: joined(orderRows.map((row) => row.inspectionType)),
      receivingUnit: joined(orderRows.map((row) => row.receivingUnit)),
      supplierName: joined(orderRows.map((row) => row.supplierName)),
      contactName: joined(orderRows.map((row) => row.contactName)),
      contactPhone: joined(orderRows.map((row) => row.contactPhone)),
      sourceStatus: joined(orderRows.map((row) => row.sourceStatus)),
      sourceSampler: joined(orderRows.map((row) => row.sourceSampler)),
      sourceRemarks: joined(orderRows.map((row) => row.remark)),
      importSource: fileName,
      importedAt: new Date().toISOString(),
    };
  });

  return { orders, sheetCount: nonEmptySheetCount, rowCount: rows.length, itemCount: orders.reduce((sum, order) => sum + order.items.length, 0) };
}
