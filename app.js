const ADMIN_EMAIL = "trung@fun.io";
const firebaseConfig = {
  apiKey: "AIzaSyDroRCHXWV_cspD1tbWgvTpr7yF-uqWWPM",
  authDomain: "trungio.firebaseapp.com",
  databaseURL: "https://trungio.firebaseio.com",
  projectId: "trungio"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const db = firebase.database();

let globalDeviceData = null;
let currentUser = null;
let allowedGroupsList = ["*"]; 
let cachedRawLogs = [];
let currentFilteredLogs = [];
let currentLogLimit = 50;
let lastSeenTracker = {};

function encodeEmail(email) {
  return email.replace(/\./g, '_dot_').replace(/@/g, '_at_');
}

function decodeEmail(key) {
  return key.replace(/_dot_/g, '.').replace(/_at_/g, '@');
}

async function updateMasterPublicIP() {
  console.log("[IP WAN] Bỏ qua tra cứu IP phía client để tránh lỗi CORS.");
}

auth.onAuthStateChanged((user) => {
  if (user) {
    currentUser = user;
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("dashboardScreen").style.display = "block";

    const isAdmin = (user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase());
    const badgeEl = document.getElementById("userBadge");
    const btnUsersPerm = document.getElementById("btnUsersPerm");

    badgeEl.className = isAdmin ? "role-badge" : "role-badge readonly";
    badgeEl.innerHTML = isAdmin 
      ? `<i class="fa-solid fa-user-shield"></i> ${user.email} (ADMIN)`
      : `<i class="fa-solid fa-eye"></i> ${user.email}`;

    btnUsersPerm.style.display = isAdmin ? "inline-block" : "none";

    fetchUserPermissions(user.email, () => {
      updateMasterPublicIP();
      listenToDatabase();
    });
  } else {
    currentUser = null;
    document.getElementById("loginScreen").style.display = "flex";
    document.getElementById("dashboardScreen").style.display = "none";
  }
});

function fetchUserPermissions(email, callback) {
  const isAdmin = (email.toLowerCase() === ADMIN_EMAIL.toLowerCase());
  if (isAdmin) {
    allowedGroupsList = ["*"];
    if (callback) callback();
    return;
  }

  const emailKey = encodeEmail(email.toLowerCase());
  db.ref("users_permission/" + emailKey).once("value", (snapshot) => {
    const permData = snapshot.val();
    if (permData && permData.allowed_groups) {
      allowedGroupsList = permData.allowed_groups;
    } else {
      allowedGroupsList = []; 
    }
    if (callback) callback();
  }, (err) => {
    allowedGroupsList = [];
    if (callback) callback();
  });
}

function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value.trim();
  const btnLogin = document.getElementById("btnLogin");

  btnLogin.innerText = "ĐANG XÁC THỰC...";
  btnLogin.disabled = true;

  auth.signInWithEmailAndPassword(email, password)
    .catch((error) => {
      alert("Lỗi đăng nhập: " + error.message);
      btnLogin.innerText = "ĐĂNG NHẬP";
      btnLogin.disabled = false;
    });
}

function logout() { auth.signOut().then(() => location.reload()); }

function restartSpecificMaster(deviceId, deviceDisplayName) {
  if (!currentUser || currentUser.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return;
  if (confirm(`Bạn có chắc chắn muốn khởi động lại Master "${deviceDisplayName}" (${deviceId}) không?`)) {
    db.ref("devices/" + deviceId).update({
      command: "restart",
      command_time: firebase.database.ServerValue.TIMESTAMP
    }).then(() => {
      alert(`Đã gửi lệnh khởi động lại tới ${deviceId}! Thiết bị sẽ reboot sau vài giây.`);
    }).catch(err => {
      alert("Lỗi khi gửi lệnh: " + err.message);
    });
  }
}

function listenToDatabase() {
  db.ref("devices").on("value", (snapshot) => {
    const newData = snapshot.val();
    const clientNow = Date.now();

    if (newData) {
      for (let id in newData) {
        let dev = newData[id];
        
        // Tự động xóa thiết bị mang firmware v1.0.0 khỏi Firebase
        if (dev.firmware === "1.0.0") {
          db.ref("devices/" + id).remove().catch(err => console.error(err));
          continue; 
        }

        let currentLastSeen = dev.last_seen ? Number(dev.last_seen) : 0;

        if (!lastSeenTracker[id]) {
          lastSeenTracker[id] = { val: currentLastSeen, blinkUntil: 0 };
        } else if (lastSeenTracker[id].val !== currentLastSeen && currentLastSeen > 0) {
          lastSeenTracker[id].val = currentLastSeen;
          lastSeenTracker[id].blinkUntil = clientNow + 3000;
        }
      }
    }

    globalDeviceData = newData;
    if (globalDeviceData) updateGroupDropdown(globalDeviceData);
    renderDevices();
  }, (error) => alert("Lỗi truy cập dữ liệu: " + error.message));

  setInterval(() => { if (globalDeviceData) renderDevices(); }, 1000);
}

function formatWithoutYear(timestamp) {
  if (!timestamp) return "Chưa xác định";
  let dateObj = new Date(timestamp);
  let timeStr = dateObj.toLocaleTimeString("vi-VN", { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let day = String(dateObj.getDate()).padStart(2, '0');
  let month = String(dateObj.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}, ${timeStr}`;
}

function isGroupAllowed(devGroup) {
  if (allowedGroupsList.includes("*")) return true;
  return allowedGroupsList.includes(devGroup);
}

function renderDevices() {
  const tbody = document.getElementById("device-table-body");
  const filterValue = document.getElementById("groupFilter").value;
  const isAdmin = currentUser && (currentUser.email.toLowerCase() === ADMIN_EMAIL.toLowerCase());

  tbody.innerHTML = "";

  if (!globalDeviceData) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color: var(--text-muted); padding:30px;">Chưa có thiết bị nào trong cơ sở dữ liệu.</td></tr>`;
    return;
  }

  const now = Date.now();
  let totalCount = 0;
  let groupsMap = {};

  for (let id in globalDeviceData) {
    let dev = globalDeviceData[id];

    if (id.toLowerCase().includes('8266') || (dev.device_name && dev.device_name.toLowerCase().includes('8266'))) {
      continue;
    }

    let devGroup = dev.group || "Chưa Phân Nhóm";

    if (!isGroupAllowed(devGroup)) continue;
    if (filterValue !== "ALL" && devGroup !== filterValue) continue;

    if (!groupsMap[devGroup]) {
      groupsMap[devGroup] = [];
    }
    groupsMap[devGroup].push({ id, dev });
    totalCount++;
  }

  if (totalCount === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color: var(--text-muted); padding:30px;">Không tìm thấy thiết bị phù hợp.</td></tr>`;
    return;
  }

  let sortedGroups = Object.keys(groupsMap).sort((a, b) => {
    if (a === "Chưa Phân Nhóm") return 1;
    if (b === "Chưa Phân Nhóm") return -1;
    return a.localeCompare(b);
  });

  sortedGroups.forEach(devGroup => {
    groupsMap[devGroup].sort((a, b) => {
      let isGatewayA = a.id.toLowerCase().includes('gateway') || (a.dev.type && a.dev.type === 'gateway');
      let isGatewayB = b.id.toLowerCase().includes('gateway') || (b.dev.type && b.dev.type === 'gateway');
      
      let nameA = a.dev.custom_name || (isGatewayA ? "Gateway Trung Tâm" : a.id);
      let nameB = b.dev.custom_name || (isGatewayB ? "Gateway Trung Tâm" : b.id);
      
      return nameA.localeCompare(nameB, 'vi', { sensitivity: 'base' });
    });

    tbody.innerHTML += `
      <tr style="background: rgba(56, 189, 248, 0.08); border-top: 2px solid var(--accent-blue);">
        <td colspan="9" style="font-weight: 700; color: var(--accent-blue); padding: 12px; font-size: 14px;">
          <i class="fa-solid fa-layer-group" style="margin-right: 6px;"></i> NHÓM: ${devGroup} <span style="font-weight: 400; color: var(--text-muted); font-size: 12px;">(${groupsMap[devGroup].length} thiết bị)</span>
        </td>
      </tr>
    `;

    groupsMap[devGroup].forEach(item => {
      let id = item.id;
      let dev = item.dev;
      
      let isGateway = id.toLowerCase().includes('gateway') || (dev.type && dev.type === 'gateway');
      let topCodeHtml = "";
      let customName = dev.custom_name || (isGateway ? "Gateway Trung Tâm" : "Chưa đặt tên");

      if (isGateway) {
        topCodeHtml = `<span class="device-esp-id" style="color: var(--accent-orange);"><i class="fa-solid fa-network-wired"></i> GATEWAY SYSTEM</span>`;
      } else {
        let cleanId = id.replace(/^ESP_/, '');
        topCodeHtml = `<span class="device-esp-id"><i class="fa-solid fa-microchip"></i> ESP_${cleanId}</span>`;
      }

      let macAddr = dev.mac || id;
      let fwVer = dev.firmware || "1.0.0";
      
      let ipWan = dev.ip_wan || dev.ip || "--";
      let ipLocal = dev.ip_local || "--";

      let lastSeenTime = dev.last_seen ? Number(dev.last_seen) : 0;
      let timeDiffSec = Math.floor((now - lastSeenTime) / 1000);

      let isOnline = (dev.status === "ONLINE") && (timeDiffSec <= 60) && (lastSeenTime > 0);

      let inCnt = dev.input_count ?? 0;
      let outCnt = dev.output_count ?? 0;
      let ratio = dev.ratio !== undefined ? parseFloat(dev.ratio) : 0.0;
      let pulseUs = dev.pulse_width_us ?? "--";
      let wifiRssi = dev.wifi_signal !== undefined ? dev.wifi_signal + " dBm" : "--";

      let tempVal = dev.temperature ?? dev.temp;
      let tempDisplay = tempVal !== undefined ? `${parseFloat(tempVal).toFixed(1)} °C` : "--";
      let voltVal = dev.voltage ?? dev.vcc;
      let voltDisplay = voltVal !== undefined ? `${parseFloat(voltVal).toFixed(2)} V` : "--";

      let isRatioError = (inCnt > 0) && (ratio < 1.95 || ratio > 2.05);

      let isBlinking = lastSeenTracker[id] && (now < lastSeenTracker[id].blinkUntil);
      let dotClass = isBlinking ? "dot-blinking" : "";

      let statusHTML = "";
      if (isOnline) {
        statusHTML = `<span class="status-badge status-online"><i class="fa-solid fa-circle ${dotClass}" style="font-size:7px;"></i> ONLINE</span>`;
      } else {
        let lastSeenStr = formatWithoutYear(lastSeenTime);
        statusHTML = `
          <span class="status-badge status-offline"><i class="fa-solid fa-circle-xmark" style="font-size:9px;"></i> OFFLINE</span>
          <span class="info-sub" style="color: var(--accent-red);">${lastSeenStr}</span>
        `;
      }

      let pulseColumnHTML = "";
      if (isGateway) {
        pulseColumnHTML = `<span style="color: var(--text-muted); font-size: 12px;"><i class="fa-solid fa-server"></i> Thiết bị điều phối trung tâm</span>`;
      } else {
        let pulseContainerClass = isRatioError ? "pulse-container-error" : "pulse-container-normal";
        let ratioDisplay = isRatioError 
          ? `<span style="color: var(--accent-red); font-weight: bold;"><i class="fa-solid fa-triangle-exclamation"></i> LỖI TỶ LỆ (${ratio}x)</span>`
          : `<b>${ratio}x</b>`;

        pulseColumnHTML = `
          <div class="${pulseContainerClass}">
            IN: <span class="pulse-counter pulse-in">${inCnt}</span> | 
            OUT: <span class="pulse-counter pulse-out">${outCnt}</span>
          </div>
          <span class="info-sub">Tỷ lệ: ${ratioDisplay} | Độ rộng: ${pulseUs} µs</span>
        `;
      }

      let safeCustomName = (dev.custom_name || "").replace(/'/g, "\\'");
      let actionTd = `
        <td>
          <div class="action-group">
            ${isGateway && isAdmin ? `<button class="btn-restart" onclick="restartSpecificMaster('${id}', '${safeCustomName}')"><i class="fa-solid fa-power-off"></i> Restart</button>` : ''}
            ${!isGateway ? `<button class="btn-log" onclick="viewHourlyLog('${id}')"><i class="fa-solid fa-clock-rotate-left"></i> Nhật Ký</button>` : ''}
            ${isAdmin ? `
              <button class="btn-edit" onclick="openEditModal('${id}', '${safeCustomName}', '${devGroup}')"><i class="fa-solid fa-pen"></i> Sửa</button>
              <button class="btn-delete" onclick="deleteDevice('${id}', '${customName}')"><i class="fa-solid fa-trash-can"></i> Xóa</button>
            ` : ''}
          </div>
        </td>`;

      tbody.innerHTML += `<tr>
        <td>${statusHTML}</td>
        <td>
          <div class="device-name-container">
            ${topCodeHtml}
            <span class="device-custom-name">${customName}</span>
          </div>
        </td>
        <td><span class="badge-group">${devGroup}</span></td>
        <td>${pulseColumnHTML}</td>
        <td>
          <div class="env-box">
            <div class="env-item"><i class="fa-solid fa-temperature-half" style="color: var(--accent-orange);"></i> <b>${tempDisplay}</b></div>
            <div class="env-item"><i class="fa-solid fa-bolt" style="color: var(--accent-yellow);"></i> <b>${voltDisplay}</b></div>
          </div>
        </td>
        <td><i class="fa-solid fa-wifi"></i> ${wifiRssi}</td>
        <td>
          <span class="badge-mac">${macAddr}</span>
          <span class="info-sub"><i class="fa-solid fa-globe"></i> WAN: ${ipWan}</span>
          <span class="info-sub"><i class="fa-solid fa-network-wired"></i> LAN: ${ipLocal}</span>
        </td>
        <td><span class="badge-fw">v${fwVer}</span></td>
        ${actionTd}
      </tr>`;
    });
  });
}

function updateGroupDropdown(data) {
  const filterSelect = document.getElementById("groupFilter");
  const currentSelected = filterSelect.value;
  let groups = new Set();
  for (let id in data) { 
    if (id.toLowerCase().includes('8266') || (data[id].device_name && data[id].device_name.toLowerCase().includes('8266'))) continue;
    let devGroup = data[id].group || "Chưa Phân Nhóm";
    if (isGroupAllowed(devGroup)) {
      groups.add(devGroup); 
    }
  }

  let optionsHTML = '<option value="ALL">-- Tất cả nhóm --</option>';
  groups.forEach(g => { optionsHTML += `<option value="${g}">${g}</option>`; });
  filterSelect.innerHTML = optionsHTML;
  filterSelect.value = groups.has(currentSelected) || currentSelected === "ALL" ? currentSelected : "ALL";
}

function openEditModal(deviceId, currentCustomName, currentGroup) {
  if (!currentUser || currentUser.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return;
  document.getElementById("editDeviceId").value = deviceId;
  document.getElementById("editDeviceName").value = currentCustomName;
  document.getElementById("editGroupName").value = currentGroup;
  document.getElementById("editModal").style.display = "flex";
}

function openUsersModal() {
  if (!currentUser || currentUser.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return;
  document.getElementById("usersModal").style.display = "flex";
  loadUserPermissionsList();
}

function loadUserPermissionsList() {
  const tbody = document.getElementById("userPermTableBody");
  tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:var(--text-muted);">Đang tải danh sách...</td></tr>`;

  db.ref("users_permission").once("value", (snapshot) => {
    const data = snapshot.val();
    if (!data) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:var(--text-muted);">Chưa có phân quyền nào.</td></tr>`;
      return;
    }

    let html = "";
    for (let emailKey in data) {
      let originalEmail = decodeEmail(emailKey);
      let groupsArr = data[emailKey].allowed_groups || [];
      let groupsStr = groupsArr.join(", ");

      html += `<tr>
        <td><b>${originalEmail}</b></td>
        <td><span class="badge-group">${groupsStr}</span></td>
        <td style="text-align:right;">
          <button class="btn-delete" style="padding:2px 6px;" onclick="deleteUserPermission('${emailKey}', '${originalEmail}')"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>`;
    }
    tbody.innerHTML = html;
  });
}

async function saveUserAndPermissions() {
  if (!currentUser || currentUser.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return;

  const email = document.getElementById("permUserEmail").value.trim().toLowerCase();
  const password = document.getElementById("permUserPassword").value.trim();
  const groupsRaw = document.getElementById("permGroups").value.trim();
  const btnSave = document.getElementById("btnSaveUser");

  if (!email) {
    alert("Vui lòng nhập Email tài khoản!");
    return;
  }

  let groupsArray = groupsRaw.split(',').map(g => g.trim()).filter(g => g.length > 0);
  if (groupsArray.length === 0) groupsArray = ["*"];

  const emailKey = encodeEmail(email);

  btnSave.innerText = "ĐANG XỬ LÝ...";
  btnSave.disabled = true;

  try {
    if (password) {
      if (password.length < 6) {
        alert("Mật khẩu phải có ít nhất 6 ký tự!");
        btnSave.innerText = "TẠO TÀI KHOẢN & LƯU QUYỀN";
        btnSave.disabled = false;
        return;
      }

      const authApiUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${firebaseConfig.apiKey}`;
      const response = await fetch(authApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email,
          password: password,
          returnSecureToken: false
        })
      });

      const authResult = await response.json();

      if (authResult.error) {
        if (authResult.error.message === "EMAIL_EXISTS") {
          console.log("Email đã tồn tại trên Auth, tiếp tục cập nhật phân quyền...");
        } else {
          throw new Error("Lỗi Firebase Auth: " + authResult.error.message);
        }
      }
    }

    await db.ref("users_permission/" + emailKey).set({
      allowed_groups: groupsArray,
      updated_at: Date.now()
    });

    alert(`Thao tác thành công cho tài khoản ${email}!`);
    document.getElementById("permUserEmail").value = "";
    document.getElementById("permUserPassword").value = "";
    document.getElementById("permGroups").value = "";
    loadUserPermissionsList();

  } catch (err) {
    alert("Lỗi: " + err.message);
  } finally {
    btnSave.innerText = "TẠO TÀI KHOẢN & LƯU QUYỀN";
    btnSave.disabled = false;
  }
}

function deleteUserPermission(emailKey, email) {
  if (!currentUser || currentUser.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return;
  if (confirm(`Xóa phân quyền của tài khoản "${email}"?`)) {
    db.ref("users_permission/" + emailKey).remove()
      .then(() => loadUserPermissionsList())
      .catch(err => alert("Lỗi khi xóa: " + err.message));
  }
}

function viewHourlyLog(macAddress) {
  const container = document.getElementById("logContainer");
  container.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding: 10px;">Đang tải nhật ký...</div>`;
  document.getElementById("currentLogMac").value = macAddress;

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const todayStr = `${year}-${month}-${day}`;
  document.getElementById("logDateFilter").value = todayStr;

  document.getElementById("logModal").style.display = "flex";

  db.ref("logs/" + macAddress).limitToLast(500).once("value", (snapshot) => {
    let logs = snapshot.val();
    if (!logs) {
      cachedRawLogs = [];
      currentFilteredLogs = [];
      container.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding: 10px;">Chưa có nhật ký log cho thiết bị này.</div>`;
      document.getElementById("logCountBadge").innerText = "Hiển thị: 0 bản ghi";
      return;
    }

    cachedRawLogs = [];
    for (let k in logs) {
      cachedRawLogs.push(logs[k]);
    }
    cachedRawLogs.sort((a, b) => b.timestamp - a.timestamp);

    filterLogsByDate();
  });
}

function displayLogItems() {
  const container = document.getElementById("logContainer");
  if (currentFilteredLogs.length === 0) {
    container.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding: 10px;">Không tìm thấy bản ghi nhật ký phù hợp.</div>`;
    document.getElementById("logCountBadge").innerText = "Hiển thị: 0 bản ghi";
    return;
  }

  const logsToDisplay = currentFilteredLogs.slice(0, currentLogLimit);

  let html = "";
  logsToDisplay.forEach(item => {
    let dateObj = new Date(item.timestamp);
    let dateStr = dateObj.toLocaleString("vi-VN");
    
    let inVal = item.hourly_in ?? item.input_count ?? item.in ?? 0;
    let outVal = item.hourly_out ?? item.output_count ?? item.out ?? 0;
    let ratioVal = item.ratio ?? 0;

    let isErr = (inVal > 0) && (ratioVal < 1.95 || ratioVal > 2.05);
    let ratioColor = isErr ? "color: var(--accent-red); font-weight:bold;" : "color: var(--accent-green);";

    let logTemp = (item.temperature !== undefined) ? `${parseFloat(item.temperature).toFixed(1)}°C` : ((item.temp !== undefined) ? `${parseFloat(item.temp).toFixed(1)}°C` : "--");
    let logVolt = (item.voltage !== undefined) ? `${parseFloat(item.voltage).toFixed(2)}V` : ((item.vcc !== undefined) ? `${parseFloat(item.vcc).toFixed(2)}V` : "--");

    html += `<div class="log-item">
      <div><i class="fa-regular fa-clock" style="color:var(--text-muted)"></i> ${dateStr}</div>
      <div>IN: <b>${inVal}</b> | OUT: <b>${outVal}</b> | Ratio: <span style="${ratioColor}">${ratioVal}x</span></div>
      <div style="color: var(--accent-orange);"><i class="fa-solid fa-temperature-half"></i> ${logTemp}</div>
      <div style="color: var(--accent-yellow);"><i class="fa-solid fa-bolt"></i> ${logVolt}</div>
    </div>`;
  });

  container.innerHTML = html;
  document.getElementById("logCountBadge").innerText = `Hiển thị: ${logsToDisplay.length} / ${currentFilteredLogs.length} bản ghi`;
}

function handleLogScroll(e) {
  const container = e.target;
  if (container.scrollTop + container.clientHeight >= container.scrollHeight - 20) {
    if (currentLogLimit < currentFilteredLogs.length) {
      currentLogLimit += 50;
      displayLogItems();
    }
  }
}

function filterLogsByDate() {
  const selectedDateVal = document.getElementById("logDateFilter").value;
  currentLogLimit = 50;

  if (!selectedDateVal) {
    currentFilteredLogs = [...cachedRawLogs];
  } else {
    currentFilteredLogs = cachedRawLogs.filter(item => {
      let itemDate = new Date(item.timestamp);
      let year = itemDate.getFullYear();
      let month = String(itemDate.getMonth() + 1).padStart(2, '0');
      let day = String(itemDate.getDate()).padStart(2, '0');
      let itemDateStr = `${year}-${month}-${day}`;
      return itemDateStr === selectedDateVal;
    });
  }

  displayLogItems();
}

function resetLogDateFilter() {
  document.getElementById("logDateFilter").value = "";
  currentLogLimit = 50;
  currentFilteredLogs = [...cachedRawLogs];
  displayLogItems();
}

function closeModal(modalId) { document.getElementById(modalId).style.display = "none"; }

function saveDeviceChanges() {
  if (!currentUser || currentUser.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return;

  const deviceId = document.getElementById("editDeviceId").value;
  const newCustomName = document.getElementById("editDeviceName").value.trim();
  const newGroup = document.getElementById("editGroupName").value.trim() || "Chưa Phân Nhóm";

  db.ref("devices/" + deviceId).update({ custom_name: newCustomName, group: newGroup })
    .then(() => { alert("Cập nhật thành công!"); closeModal("editModal"); })
    .catch(err => alert("Lỗi khi lưu: " + err.message));
}

function deleteDevice(deviceId, deviceName) {
  if (!currentUser || currentUser.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return;
  if (confirm(`Xóa thiết bị "${deviceName}"?`)) {
    db.ref("devices/" + deviceId).remove()
      .then(() => alert(`Đã xóa "${deviceName}"!`))
      .catch(err => alert("Lỗi khi xóa: " + err.message));
  }
}
