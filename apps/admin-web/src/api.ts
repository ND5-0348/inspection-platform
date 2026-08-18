const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3300/api/v1";
const TOKEN_KEY = "inspection.session.token";

export type InspectionConclusion = "PASS" | "FAIL" | "NA";

let authToken = typeof window === "undefined" ? "" : window.sessionStorage.getItem(TOKEN_KEY) ?? "";

export interface AuthUser {
  id: string;
  employeeNo: string;
  name: string;
  department: string;
  role: "ADMIN" | "SAMPLER" | "REVIEWER" | "VIEWER";
}

export interface SamplerUser extends AuthUser {
  mobile: string;
  status: "ACTIVE" | "INACTIVE" | "ON_LEAVE";
  qualifications: string[];
  activeTaskCount: number;
}

export interface Dashboard {
  pendingDispatch: number;
  inProgress: number;
  pendingReview: number;
  completedToday: number;
  activeSamplers: number;
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
  status: string;
  items: OrderItem[];
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

export interface ExcelImportSummary {
  fileName: string;
  sheetCount: number;
  rowCount: number;
  itemCount: number;
  createdCount: number;
  skippedCount: number;
  skippedOrderNos: string[];
  orders: InspectionOrder[];
}

export interface InspectionTask {
  id: string;
  taskNo: string;
  orderId: string;
  assigneeId: string;
  assigneeName: string;
  status: string;
  assignedAt: string;
  acceptedAt?: string;
  sampleItemIds: string[];
  physicalSample?: PhysicalSampleRecord;
  checkIn?: SiteCheckIn;
  evidenceFiles: EvidenceFile[];
  inspectionResults: InspectionResult[];
  submittedAt?: string;
  reviewRecords: ReviewRecord[];
  selectedItems: OrderItem[];
  order: InspectionOrder;
}

export interface PhysicalSamplePosition {
  sequence: number;
  palletNo: number;
  boxNo: number;
  itemNo: number;
}

export interface PhysicalSampleRecord {
  orderItemId: string;
  productCode: string;
  productName: string;
  batchNo: string;
  palletCount: number;
  boxesPerPallet: number;
  itemsPerBox: number;
  sampleCount: number;
  candidateTotal: number;
  ruleVersion: string;
  positions: PhysicalSamplePosition[];
  createdAt: string;
}

export interface SiteCheckIn {
  latitude: number;
  longitude: number;
  accuracy: number;
  address?: string;
  checkedAt: string;
}

export interface EvidenceFile {
  id: string;
  purpose: "CHECK_IN" | "INSPECTION" | "SAMPLE";
  sampleKey?: string;
  fileName: string;
  mimeType: string;
  size: number;
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
  uploadedAt: string;
}

export interface ResolvedLocation {
  address: string;
  provider: "BAIDU" | "AMAP" | "ORDER_ADDRESS";
  coordinateSystem: "WGS84";
}

export interface InspectionResult {
  sampleKey: string;
  conclusion: InspectionConclusion;
  note: string;
  updatedAt: string;
}

export interface ReviewRecord {
  id: string;
  reviewerName: string;
  decision: "APPROVE" | "RETURN";
  comment: string;
  reviewedAt: string;
}

function saveToken(token: string) {
  authToken = token;
  if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
  else window.sessionStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...headers, ...options?.headers },
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) saveToken("");
    throw new Error(data.message ?? "请求失败");
  }
  return data as T;
}

async function uploadFile<T>(path: string, file: File): Promise<T> {
  const body = new FormData();
  body.append("evidence", file);
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authToken ? { Authorization: `Bearer ${authToken}`, "X-Client-Channel": "WEB" } : {},
    body,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? "上传失败");
  return data as T;
}

async function uploadCheckIn<T>(taskId: string, file: File, location: { latitude: number; longitude: number; accuracy: number; address?: string }): Promise<T> {
  const query = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    accuracy: String(location.accuracy),
  });
  if (location.address) query.set("address", location.address);
  const body = new FormData();
  body.append("photo", file);
  const response = await fetch(`${API_BASE}/tasks/${taskId}/photo-check-in?${query}`, {
    method: "POST",
    headers: authToken ? { Authorization: `Bearer ${authToken}`, "X-Client-Channel": "WEB" } : {},
    body,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? "图片签到失败");
  return data as T;
}

async function evidenceBlob(evidenceId: string): Promise<Blob> {
  const response = await fetch(`${API_BASE}/evidence/${evidenceId}`, {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message ?? "签到照片加载失败");
  }
  return response.blob();
}

async function uploadSampleEvidence(
  taskId: string,
  file: File,
  metadata: { sampleKey: string; latitude: number; longitude: number; accuracy: number; address: string; coordinateSystem: "WGS84"; mapProvider: ResolvedLocation["provider"]; capturedAt: string; watermarkText: string; watermarkVersion: string },
): Promise<EvidenceFile> {
  const query = new URLSearchParams(Object.entries(metadata).map(([key, value]) => [key, String(value)]));
  const body = new FormData();
  body.append("photo", file);
  const response = await fetch(`${API_BASE}/tasks/${taskId}/sample-evidence?${query}`, {
    method: "POST",
    headers: authToken ? { Authorization: `Bearer ${authToken}`, "X-Client-Channel": "WEB" } : {},
    body,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? "样品照片上传失败");
  return data as EvidenceFile;
}

async function uploadExcel<T>(path: string, file: File): Promise<T> {
  const body = new FormData();
  body.append("file", file);
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    body,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? "Excel导入失败");
  return data as T;
}

export const api = {
  hasSession: () => Boolean(authToken),
  login: async (employeeNo: string, password: string) => {
    const session = await request<{ token: string; user: AuthUser; expiresAt: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ employeeNo, password }),
    });
    saveToken(session.token);
    return session.user;
  },
  me: async () => (await request<{ user: AuthUser }>("/auth/me")).user,
  logout: async () => {
    try { await request<void>("/auth/logout", { method: "POST", body: "{}" }); }
    finally { saveToken(""); }
  },
  dashboard: () => request<Dashboard>("/dashboard"),
  users: () => request<SamplerUser[]>("/users"),
  createSampler: (payload: { employeeNo: string; name: string; mobile: string; department: string; qualifications: string[]; initialPassword: string }) =>
    request<SamplerUser>("/users/samplers", { method: "POST", body: JSON.stringify(payload) }),
  resetSamplerPassword: (id: string, newPassword: string) =>
    request<{ message: string }>(`/users/${id}/reset-password`, { method: "POST", body: JSON.stringify({ newPassword }) }),
  updateSamplerStatus: (id: string, status: "ACTIVE" | "ON_LEAVE") =>
    request<{ user: SamplerUser; message: string }>(`/users/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
  deleteSampler: (id: string) =>
    request<{ user: SamplerUser; message: string }>(`/users/${id}`, { method: "DELETE" }),
  orders: () => request<InspectionOrder[]>("/orders"),
  createOrder: (payload: unknown) => request<InspectionOrder>("/orders", { method: "POST", body: JSON.stringify(payload) }),
  importOrders: (file: File) => uploadExcel<ExcelImportSummary>("/orders/import", file),
  deleteOrder: (id: string) => request<{ orderId: string; orderNo: string; message: string }>(`/orders/${id}`, { method: "DELETE" }),
  dispatch: (id: string) => request(`/orders/${id}/dispatch`, { method: "POST", body: "{}" }),
  tasks: () => request<InspectionTask[]>("/tasks"),
  task: (id: string) => request<InspectionTask>(`/tasks/${id}`),
  acceptTask: (id: string) => request<InspectionTask>(`/tasks/${id}/accept`, {
    method: "POST", body: "{}", headers: { "X-Client-Channel": "WEB" },
  }),
  sampleTask: (id: string, count: number) => request<{ task: InspectionTask; selectedItems: OrderItem[] }>(`/tasks/${id}/sample`, {
    method: "POST", body: JSON.stringify({ count }), headers: { "X-Client-Channel": "WEB" },
  }),
  physicalSample: (id: string, payload: { orderItemId: string; palletCount: number; boxesPerPallet: number; itemsPerBox: number; sampleCount: number }) =>
    request<InspectionTask>(`/tasks/${id}/physical-sample`, { method: "POST", body: JSON.stringify(payload), headers: { "X-Client-Channel": "WEB" } }),
  photoCheckIn: (id: string, file: File, location: { latitude: number; longitude: number; accuracy: number; address?: string }) =>
    uploadCheckIn<InspectionTask>(id, file, location),
  reverseGeocode: (latitude: number, longitude: number, fallbackAddress: string) =>
    request<ResolvedLocation>(`/maps/reverse-geocode?${new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), fallbackAddress })}`),
  uploadSampleEvidence,
  evidenceBlob,
  uploadEvidence: (id: string, file: File) => uploadFile<EvidenceFile>(`/tasks/${id}/evidence`, file),
  saveInspectionResults: (id: string, results: Array<{ sampleKey: string; conclusion: "PASS" | "FAIL" | "NA"; note: string }>) =>
    request<InspectionTask>(`/tasks/${id}/inspection-results`, { method: "PUT", body: JSON.stringify({ results }) }),
  submitReview: (id: string) => request<InspectionTask>(`/tasks/${id}/submit-review`, { method: "POST", body: "{}" }),
  reviewTask: (id: string, decision: "APPROVE" | "RETURN", comment: string) =>
    request<InspectionTask>(`/tasks/${id}/review`, { method: "POST", body: JSON.stringify({ decision, comment }) }),
};
