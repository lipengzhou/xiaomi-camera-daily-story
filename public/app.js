const state = {
  status: null,
  devices: [],
  selectedDevices: [],
  qrTimer: null,
  toastTimer: null,
};

const $ = (id) => document.getElementById(id);
const deviceKey = (device) => `${device.homeId}\u0000${device.did}`;
const fnosBasePath = "/app/xiaomi-camera-daily-story";
const appBasePath =
  window.location.pathname === fnosBasePath ||
  window.location.pathname.startsWith(`${fnosBasePath}/`)
    ? fnosBasePath
    : "";
const appUrl = (path) => `${appBasePath}${path}`;

async function api(path, options = {}) {
  const response = await fetch(appUrl(path), {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      "X-Requested-With": "XiaomiDailyStoryUI",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error?.message || `请求失败：HTTP ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

function toast(message, error = false) {
  clearTimeout(state.toastTimer);
  const element = $("toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.remove("hidden");
  state.toastTimer = setTimeout(() => element.classList.add("hidden"), 4200);
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}

function setBadge(element, text, kind = "neutral") {
  element.textContent = text;
  element.className = `badge ${kind}`;
}

function renderHistory(history = []) {
  const container = $("history");
  container.replaceChildren();
  if (!history.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无同步记录";
    container.append(empty);
    return;
  }
  history.forEach((record) => {
    const item = document.createElement("div");
    item.className = "history-item";
    const time = document.createElement("strong");
    time.textContent = formatDate(record.finishedAt);
    const trigger = document.createElement("span");
    trigger.textContent = record.trigger === "manual" ? "手动同步" : "定时同步";
    const result = document.createElement("span");
    result.className = record.status === "success" ? "" : "failed";
    result.textContent = record.message || `下载 ${record.downloaded} · 跳过 ${record.skipped} · 失败 ${record.failed}`;
    item.append(time, trigger, result);
    container.append(item);
  });
}

function renderCapabilities(capabilities) {
  const container = $("capabilities");
  container.replaceChildren();
  const labels = {
    credentials: "加密凭证",
    ffmpeg: "FFmpeg",
    ffprobe: "ffprobe",
    fileCreationTime: "文件创建时间",
    mediaDownload: "视频下载",
  };
  Object.entries(capabilities || {}).forEach(([key, available]) => {
    const item = document.createElement("span");
    item.className = `capability ${available ? "" : "missing"}`;
    item.textContent = `${labels[key] || key} · ${available ? "可用" : "缺失"}`;
    container.append(item);
  });
}

function renderEnvironment(environment, currentUser) {
  const details = $("environment-details");
  details.replaceChildren();
  const platformLabels = { darwin: "macOS", linux: "Linux", win32: "Windows" };
  const runtimeLabels = { local: "本地开发", fnos: "飞牛 fnOS 容器" };
  const rows = [
    ["运行模式", runtimeLabels[environment.runtimeMode] || environment.runtimeMode],
    ["操作系统", `${platformLabels[environment.platform] || environment.platform} ${environment.architecture}`],
    ["当前用户", `${currentUser.username} · 管理员`],
    ["凭证库", environment.credentialStore.label],
    ["持久授权", environment.credentialStore.available && environment.credentialStore.persistent ? "支持" : "不可用"],
    ["配置目录", environment.dataDir],
    ["视频目录", environment.videoDir],
    ...(environment.media
      ? [
          ["FFmpeg", environment.media.ffmpegVersion || "不可用"],
          [
            "HLS 能力",
            environment.media.available
              ? `可用 · ${environment.media.hlsOptions.length} 个兼容参数`
              : `缺失：${environment.media.missing.join("、")}`,
          ],
        ]
      : []),
  ];
  rows.forEach(([label, value]) => {
    const row = document.createElement("div");
    const title = document.createElement("span");
    title.textContent = label;
    const content = document.createElement("strong");
    content.textContent = value;
    row.append(title, content);
    details.append(row);
  });

  const issues = $("environment-issues");
  issues.replaceChildren();
  (environment.issues || []).forEach((issue) => {
    const item = document.createElement("p");
    item.className = `environment-issue ${issue.blocking ? "blocking" : ""}`;
    item.textContent = issue.message;
    issues.append(item);
  });
}

function renderVideoStorage(config, environment, hydrateForm = false) {
  const select = $("video-storage");
  const options = environment.videoStorageOptions || [];
  const previousValue = select.value;
  const optionsSignature = JSON.stringify(
    options.map((storage) => [storage.id, storage.label, storage.path, storage.available]),
  );
  if (select.dataset.optionsSignature !== optionsSignature) {
    select.replaceChildren();
    options.forEach((storage) => {
      const option = document.createElement("option");
      option.value = storage.id;
      option.disabled = !storage.available;
      option.textContent = `${storage.label}${storage.available ? "" : "（未授权）"}`;
      select.append(option);
    });
    select.dataset.optionsSignature = optionsSignature;
  }
  const desiredValue =
    !hydrateForm && options.some((storage) => storage.id === previousValue)
      ? previousValue
      : config.videoStorage;
  select.value = options.some((storage) => storage.id === desiredValue)
    ? desiredValue
    : "data-share";
  const selected = options.find((storage) => storage.id === select.value);
  $("video-storage-help").textContent = selected?.available
    ? `当前写入“${selected.label}”，视频保存到 家庭名称/摄像头名称/YYYY/MM。`
    : "所选授权文件夹当前不可用，请先在 fnOS 应用设置中添加一个读写目录并重启应用。";
}

function renderStatus(payload, hydrateForm = false) {
  state.status = payload;
  const credentialAvailable = payload.environment.credentialStore.available;
  $("hero-status").classList.add("online");
  $("hero-status").lastElementChild.textContent =
    payload.environment.runtimeMode === "fnos"
      ? "飞牛 fnOS 容器服务在线"
      : `本地服务在线 · 127.0.0.1:${payload.server.port}`;
  setBadge(
    $("auth-badge"),
    credentialAvailable ? (payload.authenticated ? "已授权" : "未授权") : "凭证库不可用",
    payload.authenticated ? "" : "error",
  );
  $("start-login").textContent = payload.authenticated ? "重新扫码授权" : "生成登录二维码";
  $("start-login").disabled = !credentialAvailable;
  $("clear-login").disabled = !credentialAvailable || !payload.authenticated;
  $("credential-summary").textContent = credentialAvailable
    ? `凭证保存到 ${payload.environment.credentialStore.label}，不写入项目文件。`
    : payload.environment.issues.find((issue) => issue.blocking)?.message || "系统凭证库不可用。";
  const profileCard = $("profile-card");
  if (payload.authenticated && payload.profile) {
    profileCard.classList.remove("hidden");
    $("profile-name").textContent = payload.profile.userName;
    $("profile-id").textContent = `账号 ID：${payload.profile.userId}`;
    $("profile-authorized-at").textContent = `授权时间：${formatDate(payload.profile.authorizedAt)}`;
    $("profile-avatar-fallback").textContent = [...payload.profile.userName][0] || "米";
    const avatar = $("profile-avatar");
    avatar.onerror = () => {
      avatar.removeAttribute("src");
      avatar.classList.add("hidden");
    };
    if (payload.profile.avatarUrl) {
      avatar.classList.remove("hidden");
      avatar.src = `${payload.profile.avatarUrl}?v=${encodeURIComponent(payload.profile.authorizedAt)}`;
    } else {
      avatar.removeAttribute("src");
      avatar.classList.add("hidden");
    }
  } else {
    profileCard.classList.add("hidden");
  }

  const sync = payload.sync;
  setBadge($("sync-badge"), sync.running ? "同步中" : "空闲", sync.running ? "" : "neutral");
  $("sync-now").disabled =
    sync.running ||
    !payload.authenticated ||
    !payload.config.devices.length ||
    !payload.capabilities.mediaDownload;
  $("current-file").textContent = sync.currentFile || "—";
  $("sync-progress").textContent = `${sync.completed} / ${sync.total}`;
  $("progress-bar").style.width = sync.total ? `${Math.round((sync.completed / sync.total) * 100)}%` : "0%";
  $("next-run").textContent = payload.nextRunAt ? formatDate(payload.nextRunAt) : "未开启";
  renderHistory(payload.history);
  renderCapabilities(payload.capabilities);
  renderEnvironment(payload.environment, payload.currentUser);
  renderVideoStorage(payload.config, payload.environment, hydrateForm);

  if (hydrateForm) {
    $("schedule-enabled").checked = payload.config.schedule.enabled;
    $("schedule-time").value = payload.config.schedule.time;
    state.selectedDevices = payload.config.devices.map((device) => ({ ...device }));
    state.selectedDevices.forEach(ensureHomeOption);
    if (state.selectedDevices.length) {
      $("home-select").value = state.selectedDevices[0].homeId;
    } else {
      $("home-select").value = "";
    }
    renderDeviceOptions();
    renderSelectedDevices();
    setBadge($("save-badge"), "已加载", "neutral");
  }
}

function ensureHomeOption(device) {
  if ([...$("home-select").options].some((option) => option.value === device.homeId)) return;
  const option = document.createElement("option");
  option.value = device.homeId;
  option.textContent = device.homeName;
  $("home-select").append(option);
}

function ensureDeviceOption(device) {
  if ([...$("device-select").options].some((option) => option.value === device.did)) return;
  const option = document.createElement("option");
  option.value = device.did;
  option.textContent = `${device.name} · ${device.model}`;
  option.dataset.model = device.model;
  option.dataset.name = device.name;
  option.dataset.homeId = device.homeId;
  option.dataset.homeName = device.homeName;
  $("device-select").append(option);
}

function renderDeviceOptions(selectedDid = "") {
  const homeId = $("home-select").value;
  const devices = state.devices.filter((device) => device.homeId === homeId);
  $("device-select").replaceChildren(
    new Option(homeId ? "请选择摄像头" : "请先选择家庭", ""),
  );
  devices.forEach(ensureDeviceOption);
  $("device-select").disabled = !homeId || devices.length === 0;
  if (selectedDid && devices.some((device) => device.did === selectedDid)) {
    $("device-select").value = selectedDid;
  }
  $("add-device").disabled = !$("device-select").value;
}

function renderSelectedDevices() {
  const container = $("selected-devices");
  container.replaceChildren();
  $("selected-device-count").textContent = `${state.selectedDevices.length} 台`;
  if (!state.selectedDevices.length) {
    const empty = document.createElement("p");
    empty.className = "empty compact-empty";
    empty.textContent = "尚未添加摄像头";
    container.append(empty);
    return;
  }
  state.selectedDevices.forEach((device) => {
    const item = document.createElement("div");
    item.className = "selected-device";
    const details = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = `${device.homeName} / ${device.name}`;
    const model = document.createElement("span");
    model.textContent = device.model;
    details.append(name, model);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost danger compact";
    remove.textContent = "移除";
    remove.addEventListener("click", () => {
      state.selectedDevices = state.selectedDevices.filter(
        (candidate) => deviceKey(candidate) !== deviceKey(device),
      );
      renderSelectedDevices();
      setBadge($("save-badge"), "未保存", "neutral");
    });
    item.append(details, remove);
    container.append(item);
  });
}

function addSelectedDevice() {
  const option = $("device-select").selectedOptions[0];
  if (!option?.value) return;
  const device = state.devices.find(
    (candidate) => candidate.homeId === $("home-select").value && candidate.did === option.value,
  );
  if (!device) return;
  if (state.selectedDevices.some((candidate) => deviceKey(candidate) === deviceKey(device))) {
    toast("该摄像头已经添加。", true);
    return;
  }
  state.selectedDevices.push({
    did: device.did,
    model: device.model,
    name: device.name,
    homeId: device.homeId,
    homeName: device.homeName,
  });
  renderSelectedDevices();
  setBadge($("save-badge"), "未保存", "neutral");
}

async function refreshStatus(hydrateForm = false) {
  try {
    renderStatus(await api("/api/status"), hydrateForm);
  } catch (error) {
    $("hero-status").classList.remove("online");
    $("hero-status").lastElementChild.textContent = "本地服务不可用";
    toast(error.message, true);
  }
}

async function pollQr() {
  const qr = await api("/api/auth/qr/status");
  $("qr-message").textContent = qr.message || "等待扫码";
  if (qr.status === "success") {
    clearInterval(state.qrTimer);
    $("qr-stage").classList.add("hidden");
    toast("扫码授权成功，凭证已加密保存。");
    await refreshStatus(true);
    await loadDevices();
  } else if (qr.status === "expired" || qr.status === "error") {
    clearInterval(state.qrTimer);
    toast(qr.message || "二维码登录失败", true);
  }
}

async function startLogin() {
  try {
    const qr = await api("/api/auth/qr", { method: "POST", body: "{}" });
    $("qr-image").src = appUrl(`/api/auth/qr/${qr.id}.png?t=${Date.now()}`);
    $("qr-message").textContent = qr.message;
    $("qr-stage").classList.remove("hidden");
    clearInterval(state.qrTimer);
    state.qrTimer = setInterval(() => pollQr().catch((error) => toast(error.message, true)), 1800);
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadDevices() {
  try {
    const devices = await api("/api/devices");
    const selectedHomeId =
      $("home-select").value || state.selectedDevices[0]?.homeId || "";
    const selectedDeviceId = $("device-select").value;
    state.devices = devices;
    state.selectedDevices = state.selectedDevices.map(
      (selected) =>
        devices.find((device) => deviceKey(device) === deviceKey(selected)) || selected,
    );
    $("home-select").replaceChildren(new Option("请选择家庭", ""));
    devices.forEach(ensureHomeOption);
    if (selectedHomeId && devices.some((device) => device.homeId === selectedHomeId)) {
      $("home-select").value = selectedHomeId;
    }
    renderDeviceOptions(selectedDeviceId);
    renderSelectedDevices();
    const homeCount = new Set(devices.map((device) => device.homeId)).size;
    toast(`已读取 ${homeCount} 个家庭、${devices.length} 台摄像头。`);
  } catch (error) {
    toast(error.message, true);
  }
}

async function saveConfig(event) {
  event.preventDefault();
  const config = {
    schemaVersion: 1,
    videoStorage: $("video-storage").value,
    devices: state.selectedDevices,
    story: {
      region: "CN",
      timezone: "Asia/Shanghai",
    },
    schedule: {
      enabled: $("schedule-enabled").checked,
      time: $("schedule-time").value,
      timezone: "Asia/Shanghai",
      catchUpOnStart: state.status?.config.schedule.catchUpOnStart ?? false,
    },
  };
  try {
    await api("/api/config", { method: "PUT", body: JSON.stringify(config) });
    setBadge($("save-badge"), "已保存", "");
    toast("配置已保存。");
    await refreshStatus(false);
  } catch (error) {
    setBadge($("save-badge"), "保存失败", "error");
    toast(error.message, true);
  }
}

async function syncNow() {
  try {
    await api("/api/sync", { method: "POST", body: "{}" });
    toast("同步任务已启动。");
    await refreshStatus(false);
  } catch (error) {
    toast(error.message, true);
  }
}

$("start-login").addEventListener("click", startLogin);
$("clear-login").addEventListener("click", async () => {
  try {
    await api("/api/auth/session", { method: "DELETE" });
    $("qr-stage").classList.add("hidden");
    toast("米家授权已清除。");
    await refreshStatus(true);
  } catch (error) { toast(error.message, true); }
});
$("load-devices").addEventListener("click", loadDevices);
$("home-select").addEventListener("change", () => renderDeviceOptions());
$("device-select").addEventListener("change", () => {
  $("add-device").disabled = !$("device-select").value;
});
$("add-device").addEventListener("click", addSelectedDevice);
$("video-storage").addEventListener("change", () => {
  const storage = state.status?.environment.videoStorageOptions?.find(
    (candidate) => candidate.id === $("video-storage").value,
  );
  $("video-storage-help").textContent = storage
    ? `当前写入“${storage.label}”，视频保存到 家庭名称/摄像头名称/YYYY/MM。`
    : "视频保存到 家庭名称/摄像头名称/YYYY/MM。";
  setBadge($("save-badge"), "未保存", "neutral");
});
$("config-form").addEventListener("submit", saveConfig);
$("sync-now").addEventListener("click", syncNow);
$("refresh-status").addEventListener("click", () => refreshStatus(false));

await refreshStatus(true);
setInterval(() => refreshStatus(false), 2500);
