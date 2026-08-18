import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseWeeklyPlanWorkbook, WEEKLY_PLAN_HEADERS } from "../src/import/excel-order-import.js";

function appendRow(sheet: ExcelJS.Worksheet, values: Array<string | number | Date>) {
  sheet.addRow(values);
}

describe("weekly inspection plan import", () => {
  it("maps all source fields and aggregates repeated material rows", async () => {
    const workbook = new ExcelJS.Workbook();
    const firstSheet = workbook.addWorksheet("六安");
    firstSheet.addRow([...WEEKLY_PLAN_HEADERS]);
    appendRow(firstSheet, [
      1, "到货质检", "AHDD202601050115", "164108111466144", new Date("2026-05-16T00:00:00Z"), "六安分公司",
      "测试供应商", "30010001", "电缆", "3×25", 2, "张三", 1, "待检查", "李工", "13800138000", "安徽省六安市测试路1号", "首批",
    ]);
    appendRow(firstSheet, [
      2, "到货质检", "AHDD202601050115", "164108111466144", "2026-05-16", "六安分公司",
      "测试供应商", "30010001", "电缆", "3×25", 3, "张三", 0, "待检查", "李工", "13800138000", "安徽省六安市测试路1号", "复验",
    ]);
    const secondSheet = workbook.addWorksheet("芜湖");
    secondSheet.addRow([...WEEKLY_PLAN_HEADERS]);
    appendRow(secondSheet, [
      1, "厂内质检", "AHDD202601050116", "164108111466145", "2026/05/17", "芜湖分公司",
      "另一供应商", "30010002", "开关柜", "KYN28", 1, "王五", 0, "未开始", "赵工", "13900139000", "安徽省芜湖市测试路2号", "",
    ]);

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const result = await parseWeeklyPlanWorkbook(buffer, "质检周计划.xlsx");

    expect(result).toMatchObject({ sheetCount: 2, rowCount: 3, itemCount: 2 });
    expect(result.orders).toHaveLength(2);
    const order = result.orders.find((item) => item.orderNo === "AHDD202601050115")!;
    expect(order).toMatchObject({
      inspectionType: "到货质检",
      receivingUnit: "六安分公司",
      supplierName: "测试供应商",
      contactName: "李工",
      contactPhone: "13800138000",
      sourceStatus: "待检查",
      sourceSampler: "张三",
      importSource: "质检周计划.xlsx",
    });
    expect(order.items[0]).toMatchObject({
      orderLineId: "164108111466144",
      productCode: "30010001",
      productName: "电缆",
      specification: "3×25",
      sampleQuantity: 5,
      quantity: 5,
      completedSampleQuantity: 1,
      remark: "首批、复验",
    });
  });

  it("rejects a workbook whose template headers were changed", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("错误模板");
    const headers = [...WEEKLY_PLAN_HEADERS];
    headers[2] = "采购单号";
    sheet.addRow(headers);
    sheet.addRow(new Array(headers.length).fill("测试"));
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(parseWeeklyPlanWorkbook(buffer, "错误.xlsx")).rejects.toThrow("第3列表头应为“抽样采购订单号”");
  });
});
