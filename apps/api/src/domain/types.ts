export type UserRole = "ADMIN" | "SAMPLER" | "REVIEWER" | "VIEWER";
export type UserStatus = "ACTIVE" | "INACTIVE" | "ON_LEAVE";
export type OrderStatus = "DRAFT" | "PENDING_DISPATCH" | "DISPATCHED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
export type TaskStatus = "PENDING_ACCEPTANCE" | "ACCEPTED" | "IN_PROGRESS" | "PENDING_REVIEW" | "COMPLETED" | "REJECTED";
export type InspectionConclusion = "PASS" | "FAIL" | "NA";

export interface User {
  id: string;
  employeeNo: string;
  name: string;
  mobile: string;
  department: string;
  role: UserRole;
  status: UserStatus;
  qualifications: string[];
  activeTaskCount: number;
}

export interface AuthSession {
  token: string;
  user: User;
  expiresAt: string;
}

export interface OrderItem {
  id: string;
  productCode: string;
  productName: string;
  batchNo: string;
  quantity: number;
  orderLineId?: string;
  specification?: string;
  sampleQuantity?: number;
  completedSampleQuantity?: number;
  sourceSampler?: string;
  sourceStatus?: string;
  remark?: string;
}

export interface InspectionOrder {
  id: string;
  orderNo: string;
  customerName: string;
  siteAddress: string;
  productCategory: string;
  plannedAt: string;
  status: OrderStatus;
  items: OrderItem[];
  createdAt: string;
  inspectionType?: string;
  receivingUnit?: string;
  supplierName?: string;
  contactName?: string;
  contactPhone?: string;
  sourceStatus?: string;
  sourceSampler?: string;
  sourceRemarks?: string;
  importSource?: string;
  importedAt?: string;
}

export interface InspectionTask {
  id: string;
  taskNo: string;
  orderId: string;
  assigneeId: string;
  assigneeName: string;
  status: TaskStatus;
  assignedAt: string;
  acceptedAt?: string;
  sampleItemIds: string[];
  physicalSample?: PhysicalSampleRecord;
  checkIn?: SiteCheckIn;
  evidenceFiles?: EvidenceFile[];
  inspectionResults?: InspectionResult[];
  submittedAt?: string;
  reviewRecords?: ReviewRecord[];
}

export interface PhysicalSamplePosition {
  sequence: number;
  palletNo: number;
  boxNo: number;
  itemNo: number;
}

export interface PhysicalSampleRecord {
  id: string;
  orderItemId: string;
  productCode: string;
  productName: string;
  batchNo: string;
  palletCount: number;
  boxesPerPallet: number;
  itemsPerBox: number;
  sampleCount: number;
  candidateTotal: number;
  candidateHash: string;
  ruleVersion: string;
  positions: PhysicalSamplePosition[];
  createdBy: string;
  createdAt: string;
}

export interface SiteCheckIn {
  latitude: number;
  longitude: number;
  accuracy: number;
  address?: string;
  channel: string;
  checkedAt: string;
}

export interface EvidenceFile {
  id: string;
  taskId: string;
  purpose: "CHECK_IN" | "INSPECTION" | "SAMPLE";
  sampleKey?: string;
  fileName: string;
  mimeType: string;
  size: number;
  storageKey: string;
  sha256: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  address?: string;
  coordinateSystem?: string;
  mapProvider?: string;
  capturedAt?: string;
  watermarkText?: string;
  watermarkVersion?: string;
  uploadedBy: string;
  uploadedAt: string;
}

export interface InspectionResult {
  sampleKey: string;
  conclusion: InspectionConclusion;
  note: string;
  updatedAt: string;
}

export interface ReviewRecord {
  id: string;
  reviewerId: string;
  reviewerName: string;
  decision: "APPROVE" | "RETURN";
  comment: string;
  reviewedAt: string;
}

export interface RandomAudit {
  id: string;
  type: "ASSIGNMENT" | "SAMPLING";
  subjectId: string;
  ruleVersion: string;
  candidateHash: string;
  candidateCount: number;
  selectedIds: string[];
  createdAt: string;
}

export interface AuditLog {
  id: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  detail: Record<string, unknown>;
  createdAt: string;
}
