let loginPromise;

function wxRequest(config) {
  return new Promise((resolve, reject) => {
    wx.request({
      ...config,
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.data);
        else reject(new Error(response.data?.message || "请求失败"));
      },
      fail: reject
    });
  });
}

function ensureSession() {
  const app = getApp();
  if (app.globalData.authToken) return Promise.resolve(app.globalData.authToken);
  if (loginPromise) return loginPromise;

  // 本机开发账号；腾讯云上线时替换为 wx.login code + 企业人员绑定。
  loginPromise = wxRequest({
    url: `${app.globalData.apiBaseUrl}/auth/login`,
    method: "POST",
    header: { "content-type": "application/json" },
    data: { employeeNo: "S001", password: "Sampler@123" }
  }).then((session) => {
    app.globalData.authToken = session.token;
    app.globalData.currentUser = session.user;
    return session.token;
  }).finally(() => { loginPromise = null; });

  return loginPromise;
}

function request(path, options = {}) {
  return ensureSession().then((token) => {
    const app = getApp();
    return wxRequest({
      url: `${app.globalData.apiBaseUrl}${path}`,
      method: options.method || "GET",
      data: options.method === "POST" && options.data === undefined ? {} : options.data,
      header: {
        "content-type": "application/json",
        "authorization": `Bearer ${token}`,
        "x-client-channel": "MINI_PROGRAM"
      }
    });
  });
}

function uploadEvidence(taskId, filePath) {
  return ensureSession().then((token) => {
    const app = getApp();
    return new Promise((resolve, reject) => {
      wx.uploadFile({
        url: `${app.globalData.apiBaseUrl}/tasks/${taskId}/evidence`,
        filePath,
        name: "evidence",
        header: { "authorization": `Bearer ${token}`, "x-client-channel": "MINI_PROGRAM" },
        success(response) {
          const data = JSON.parse(response.data || "{}");
          if (response.statusCode >= 200 && response.statusCode < 300) resolve(data);
          else reject(new Error(data.message || "上传失败"));
        },
        fail: reject
      });
    });
  });
}

function photoCheckIn(taskId, filePath, location) {
  return ensureSession().then((token) => {
    const app = getApp();
    const query = `latitude=${encodeURIComponent(location.latitude)}&longitude=${encodeURIComponent(location.longitude)}&accuracy=${encodeURIComponent(location.accuracy || 0)}&address=${encodeURIComponent(location.address || "")}`;
    return new Promise((resolve, reject) => {
      wx.uploadFile({
        url: `${app.globalData.apiBaseUrl}/tasks/${taskId}/photo-check-in?${query}`,
        filePath,
        name: "photo",
        header: { "authorization": `Bearer ${token}`, "x-client-channel": "MINI_PROGRAM" },
        success(response) {
          const data = JSON.parse(response.data || "{}");
          if (response.statusCode >= 200 && response.statusCode < 300) resolve(data);
          else reject(new Error(data.message || "图片签到失败"));
        },
        fail: reject
      });
    });
  });
}

function uploadSampleEvidence(taskId, filePath, metadata) {
  return ensureSession().then((token) => {
    const app = getApp();
    const query = Object.keys(metadata).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(metadata[key])}`).join("&");
    return new Promise((resolve, reject) => {
      wx.uploadFile({
        url: `${app.globalData.apiBaseUrl}/tasks/${taskId}/sample-evidence?${query}`,
        filePath,
        name: "photo",
        header: { "authorization": `Bearer ${token}`, "x-client-channel": "MINI_PROGRAM" },
        success(response) {
          const data = JSON.parse(response.data || "{}");
          if (response.statusCode >= 200 && response.statusCode < 300) resolve(data);
          else reject(new Error(data.message || "样品照片上传失败"));
        },
        fail: reject
      });
    });
  });
}

function downloadEvidence(evidenceId) {
  return ensureSession().then((token) => {
    const app = getApp();
    return new Promise((resolve, reject) => wx.downloadFile({
      url: `${app.globalData.apiBaseUrl}/evidence/${evidenceId}`,
      header: { "authorization": `Bearer ${token}`, "x-client-channel": "MINI_PROGRAM" },
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.tempFilePath);
        else reject(new Error("照片预览加载失败"));
      },
      fail: reject
    }));
  });
}

module.exports = {
  ensureSession,
  getTasks: () => request("/tasks"),
  getTask: (id) => request(`/tasks/${id}`),
  acceptTask: (id) => request(`/tasks/${id}/accept`, { method: "POST" }),
  sampleTask: (id, count) => request(`/tasks/${id}/sample`, { method: "POST", data: { count } }),
  physicalSample: (id, data) => request(`/tasks/${id}/physical-sample`, { method: "POST", data }),
  photoCheckIn,
  uploadEvidence,
  uploadSampleEvidence,
  downloadEvidence,
  reverseGeocode: (latitude, longitude, fallbackAddress) => request(`/maps/reverse-geocode?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&fallbackAddress=${encodeURIComponent(fallbackAddress || "")}`),
  saveInspectionResults: (id, results) => request(`/tasks/${id}/inspection-results`, { method: "PUT", data: { results } }),
  submitReview: (id) => request(`/tasks/${id}/submit-review`, { method: "POST" })
};
