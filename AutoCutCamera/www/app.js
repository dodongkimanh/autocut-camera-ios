// AutoCut Camera — điện thoại làm camera cho AutoCut Studio (WebRTC trong mạng Wi-Fi).
//
// Xoá phông trên điện thoại: mỗi khung hình gửi đi gồm 2 phần xếp chồng (video không có kênh trong suốt):
//   ┌──────────────┐  ← ảnh màu  W × H
//   │              │
//   ├───────┬──────┤  ← mặt nạ người (xám) W/2 × H/2 ở góc trái; phần phải để đen
//   └───────┴──────┘
// AutoCut nhận biết qua kênh dữ liệu ("packed": true) rồi tự tinh chỉnh viền theo ảnh màu.

const $ = (id) => document.getElementById(id);
const native = window.AutoCutNative;
const store = {
  get: (k, d) => {
    try {
      const v = localStorage.getItem(`ac.${k}`);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(`ac.${k}`, JSON.stringify(v));
    } catch {}
  },
};

const S = {
  facing: store.get("facing", "user"),
  // Mặc định tắt: AI trong WebView điện thoại chậm (~3 mặt nạ/giây); máy tính có card đồ hoạ xoá phông mượt hơn
  ai: store.get("ai2", false),
  hd: store.get("hd", false),
  mic: true,
  host: store.get("host", ""),
  port: store.get("port", 39391),
  code: store.get("code", ""),
  hostName: "",
  // Mã riêng của máy này: AutoCut nhận ra điện thoại khi kết nối lại (nhiều điện thoại cùng lúc)
  id: store.get("id", "") || (() => {
    const id = `ph_${Math.random().toString(36).slice(2, 10)}`;
    store.set("id", id);
    return id;
  })(),
};

let camStream = null; // luồng camera + micro
let outTrack = null; // track video đang gửi (camera hoặc khung ghép có mặt nạ)
let pc = null;
let dc = null;
let videoSender = null;
let audioSender = null;
let connecting = false;
let statsTimer = 0;

const preview = $("preview");
const setStatus = (text, cls = "") => {
  $("status").textContent = text;
  $("status").className = `status ${cls}`;
};
const showErr = (t) => ($("err").textContent = t || "");

// ---------------------------------------------------------------- camera
let camKey = "";
/** Mở camera. Đang mở đúng camera / độ phân giải thì dùng tiếp (mở lại liền tay hay lỗi trên Samsung). */
async function openCamera(force = false) {
  const key = `${S.facing}|${S.hd}`;
  const live = camStream?.getVideoTracks().some((t) => t.readyState === "live");
  if (!force && live && key === camKey) return;
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
  const [w, h] = S.hd ? [1920, 1080] : [1280, 720];
  const video = { facingMode: S.facing, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } };
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  // Camera vừa nhả có thể còn bận vài trăm ms → thử lại
  let lastErr;
  for (let i = 0; i < 4 && !camStream; i++) {
    if (i) await new Promise((r) => setTimeout(r, 400 * i));
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video, audio });
    } catch (e) {
      lastErr = e;
      // Không có micro / bị từ chối micro → chỉ lấy hình
      if (e.name === "NotFoundError" || e.name === "NotAllowedError") {
        camStream = await navigator.mediaDevices.getUserMedia({ video }).catch((e2) => ((lastErr = e2), null));
      }
    }
  }
  if (!camStream) {
    throw new Error(
      lastErr?.name === "NotReadableError"
        ? "Camera đang bận — mở khoá màn hình điện thoại, tắt app camera khác (Zalo, Messenger…) rồi thử lại."
        : `Không mở được camera: ${lastErr?.message ?? lastErr}`,
    );
  }
  camKey = key;
  camStream.getAudioTracks().forEach((t) => (t.enabled = S.mic));
  preview.srcObject = camStream;
  preview.classList.toggle("mirror", S.facing === "user");
  await preview.play().catch(() => {});
  await new Promise((r) => (preview.videoWidth ? r() : (preview.onloadedmetadata = r)));
}

// ---------------------------------------------------------------- xoá phông trên điện thoại
let packTimer = 0;
let packing = false;
const packed = $("packed");
const pctx = packed.getContext("2d");
// Số liệu AI (chẩn đoán qua USB)
const seg = { ms: 0, fps: 0, ready: false, busy: false, done: 0 };
window.__acSeg = seg;
const maskCanvas = document.createElement("canvas");
const mctx = maskCanvas.getContext("2d");

// AI chạy ở luồng riêng (seg-worker.js) → luồng gửi hình không bao giờ phải chờ AI
let worker = null;
let segLoading = null;
function loadSegmenter() {
  segLoading ??= new Promise((resolve, reject) => {
    worker = new Worker("./seg-worker.js");
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") resolve();
      else if (m.type === "error") reject(new Error(m.message));
      else if (m.type === "mask") {
        if (maskCanvas.width !== m.w || maskCanvas.height !== m.h) {
          maskCanvas.width = m.w;
          maskCanvas.height = m.h;
        }
        mctx.putImageData(new ImageData(m.data, m.w, m.h), 0, 0);
        seg.ready = true;
        seg.busy = false;
        seg.done++;
        seg.ms = seg.ms * 0.8 + m.ms * 0.2;
      } else seg.busy = false;
    };
    worker.onerror = (e) => reject(new Error(e.message || "Lỗi AI"));
    worker.postMessage({ type: "init" });
  }).catch((e) => {
    segLoading = null;
    worker?.terminate();
    worker = null;
    throw e;
  });
  return segLoading;
}
setInterval(() => {
  seg.fps = seg.done;
  seg.done = 0;
}, 1000);

/** Gửi ảnh nhỏ (cạnh dài 256px) sang luồng AI — không chờ kết quả. */
function requestMask(vw, vh) {
  if (seg.busy || !worker) return;
  seg.busy = true;
  const k = 256 / Math.max(vw, vh);
  createImageBitmap(preview, { resizeWidth: Math.round(vw * k), resizeHeight: Math.round(vh * k), resizeQuality: "low" })
    .then((bmp) => worker.postMessage({ type: "frame", bmp, ts: performance.now() }, [bmp]))
    .catch(() => (seg.busy = false));
}

/** Vẽ một khung ghép: ảnh màu ở trên, mặt nạ người (mới nhất) ở góc dưới trái. */
function packFrame() {
  const vw = preview.videoWidth;
  const vh = preview.videoHeight;
  if (!vw || !worker) return;
  // Khung ghép tối đa 720p (cạnh ngắn 720) để chip mã hoá video không quá tải; kích thước chia hết cho 4
  const k0 = Math.min(1, 720 / Math.min(vw, vh));
  const W = Math.round((vw * k0) / 4) * 4;
  const H = Math.round((vh * k0) / 4) * 4;
  if (packed.width !== W || packed.height !== H * 1.5) {
    packed.width = W;
    packed.height = H * 1.5;
    pctx.fillStyle = "#000";
    pctx.fillRect(0, 0, W, H * 1.5);
  }
  pctx.drawImage(preview, 0, 0, W, H);
  // AI rảnh thì gửi khung mới; mặt nạ vẽ dưới đây là bản mới nhất AI trả về
  requestMask(vw, vh);
  if (seg.ready) {
    pctx.imageSmoothingQuality = "high";
    pctx.drawImage(maskCanvas, 0, H, W / 2, H / 2);
  }
}

function startPacking() {
  if (packing) return;
  packing = true;
  const loop = () => {
    if (!packing) return;
    try {
      packFrame();
    } catch (e) {
      console.warn(e);
    }
    if (preview.requestVideoFrameCallback) preview.requestVideoFrameCallback(loop);
    else packTimer = setTimeout(loop, 33);
  };
  loop();
}
function stopPacking() {
  packing = false;
  clearTimeout(packTimer);
}

/** Track video để gửi: camera thẳng, hoặc khung ghép có mặt nạ khi bật xoá phông. */
async function buildOutTrack() {
  if (S.ai) {
    setStatus("Đang tải AI xoá phông…", "wait");
    await loadSegmenter();
    startPacking();
    // Chờ khung ghép đầu tiên
    await new Promise((r) => setTimeout(r, 150));
    return packed.captureStream(30).getVideoTracks()[0];
  }
  stopPacking();
  return camStream.getVideoTracks()[0];
}

async function refreshOutTrack() {
  const old = outTrack;
  outTrack = await buildOutTrack();
  if (videoSender) await videoSender.replaceTrack(outTrack);
  if (old && old !== outTrack && old !== camStream?.getVideoTracks()[0]) old.stop();
  sendInfo();
  updateButtons();
}

// ---------------------------------------------------------------- kết nối WebRTC
const base = () => `http://${S.host}:${S.port}`;

/**
 * Gọi tới máy AutoCut. Android: fetch của WebView. iPhone: WKWebView chặn trang trong app gọi
 * http://192.168.x.x → nhờ phần Swift gửi giúp (window.webkit.messageHandlers.acHttp).
 * Trả về đối tượng giống Response: ok, status, json().
 */
async function http(url, { method = "GET", body, timeout = 8000 } = {}) {
  const ios = window.webkit?.messageHandlers?.acHttp;
  if (!ios) return fetch(url, { method, body, headers: body ? { "Content-Type": "application/json" } : undefined, signal: AbortSignal.timeout(timeout) });
  const r = await ios.postMessage({ url, method, body: body ?? null, timeout });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(r.body || "null") };
}

function sendInfo() {
  if (dc?.readyState !== "open") return;
  const v = preview;
  dc.send(JSON.stringify({ type: "info", packed: !!S.ai, facing: S.facing, w: v.videoWidth, h: v.videoHeight, name: native?.deviceName?.() ?? "Điện thoại" }));
}

function waitIce(conn, ms) {
  return new Promise((resolve) => {
    if (conn.iceGatheringState === "complete") return resolve();
    const t = setTimeout(resolve, ms);
    conn.addEventListener("icegatheringstatechange", () => {
      if (conn.iceGatheringState === "complete") {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

async function connect() {
  if (connecting) return;
  S.code = $("code").value.replace(/\D/g, "");
  if ($("host").value.trim()) S.host = $("host").value.trim();
  S.port = Number($("port").value) || S.port || 39391;
  S.ai = $("ai").checked;
  S.hd = $("hd").checked;
  if (!S.host) return showErr("Chưa tìm thấy máy AutoCut — bấm 🔍 Tìm lại, hoặc nhập địa chỉ IP của máy tính.");
  if (S.code.length !== 6) return showErr("Nhập đủ 6 số mã ghép đôi (xem trên AutoCut).");
  store.set("host", S.host);
  store.set("port", S.port);
  store.set("code", S.code);
  store.set("ai2", S.ai);
  store.set("hd", S.hd);
  showErr("");
  connecting = true;
  $("go").disabled = true;
  $("go").textContent = "Đang kết nối…";
  try {
    await openCamera();
    outTrack = await buildOutTrack();
    setStatus("Đang kết nối…", "wait");

    pc = new RTCPeerConnection({ iceServers: [] });
    const ms = new MediaStream([outTrack, ...camStream.getAudioTracks()]);
    const vt = pc.addTransceiver(outTrack, { direction: "sendonly", streams: [ms] });
    videoSender = vt.sender;
    // Ưu tiên H.264 (điện thoại có chip mã hoá phần cứng → mát máy, ít trễ)
    try {
      const caps = RTCRtpSender.getCapabilities("video").codecs;
      const h264 = caps.filter((c) => /h264/i.test(c.mimeType));
      if (h264.length) vt.setCodecPreferences([...h264, ...caps.filter((c) => !/h264/i.test(c.mimeType))]);
    } catch {}
    const at = camStream.getAudioTracks()[0];
    if (at) audioSender = pc.addTransceiver(at, { direction: "sendonly", streams: [ms] }).sender;

    dc = pc.createDataChannel("ctl");
    dc.onopen = sendInfo;
    dc.onmessage = (e) => onCommand(JSON.parse(e.data));
    pc.onconnectionstatechange = () => {
      const st = pc?.connectionState;
      if (st === "connected") {
        setStatus(`● Đang gửi tới ${S.hostName || S.host}`, "live");
        tuneBitrate();
        // Hiện tốc độ thật trên thanh trạng thái
        clearInterval(statsTimer);
        lastStats = null;
        statsTimer = setInterval(async () => {
          if (!pc) return clearInterval(statsTimer);
          const s = await readStats().catch(() => null);
          if (s) setStatus(`● ${s.fps} hình/s · ${(s.kbps / 1000).toFixed(1)} Mbps${s.rttMs != null ? ` · ${s.rttMs} ms` : ""}${s.limit && s.limit !== "none" ? ` · máy ${s.limit === "cpu" ? "nóng/yếu" : "mạng yếu"}` : ""}`, "live");
        }, 2000);
      } else if (st === "failed" || st === "disconnected" || st === "closed") {
        if (pc) disconnect(st === "closed" ? "" : "Mất kết nối với máy tính. Kiểm tra Wi-Fi rồi kết nối lại.");
      }
    };

    await pc.setLocalDescription(await pc.createOffer());
    await waitIce(pc, 2500);
    const r = await http(`${base()}/phone/offer`, {
      method: "POST",
      body: JSON.stringify({ code: S.code, sdp: pc.localDescription.sdp, info: { id: S.id, name: native?.deviceName?.() ?? "Điện thoại", packed: S.ai, facing: S.facing } }),
    }).catch(() => null);
    if (!r) throw new Error(`Không kết nối được tới ${S.host}:${S.port}.\nKiểm tra: cùng Wi-Fi, AutoCut đang mở, tường lửa Windows cho phép AutoCut / Node.js.`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `Lỗi ${r.status}`);

    setStatus("Chờ AutoCut nhận…", "wait");
    let answer = null;
    for (let i = 0; i < 90 && !answer; i++) {
      await new Promise((res) => setTimeout(res, 500));
      const a = await http(`${base()}/phone/answer?id=${j.id}`).catch(() => null);
      if (!a) continue;
      if (a.status === 200) answer = (await a.json()).sdp;
      else if (a.status === 404) break;
      else if (i === 8 && !(await a.json()).seen) setStatus("Chờ AutoCut… (trên máy tính chọn Camera → 📱 Điện thoại, bấm Bật camera)", "wait");
    }
    if (!answer) throw new Error("AutoCut chưa nhận kết nối. Trên máy tính: tab 📷 Camera → ô Camera chọn “📱 Điện thoại” → bấm Bật camera, rồi thử lại.");
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    $("connect").hidden = true;
    $("controls").hidden = false;
    updateButtons();
  } catch (e) {
    disconnect(e instanceof Error ? e.message : String(e));
  } finally {
    connecting = false;
    $("go").disabled = false;
    $("go").textContent = "Kết nối";
  }
}

/** Số liệu kết nối (hiện trên thanh trạng thái + đọc được khi chẩn đoán qua USB). */
let lastStats = null;
async function readStats() {
  if (!pc) return null;
  const rep = await pc.getStats();
  let o = null;
  let remote = null;
  let pair = null;
  rep.forEach((s) => {
    if (s.type === "outbound-rtp" && s.kind === "video") o = s;
    if (s.type === "remote-inbound-rtp" && s.kind === "video") remote = s;
    if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s;
  });
  if (!o) return null;
  const now = { t: o.timestamp, bytes: o.bytesSent, frames: o.framesEncoded, encTime: o.totalEncodeTime ?? 0 };
  const prev = lastStats;
  lastStats = now;
  if (!prev) return null;
  const dt = (now.t - prev.t) / 1000;
  const frames = now.frames - prev.frames;
  let local = null;
  if (pair) rep.forEach((s) => s.id === pair.localCandidateId && (local = s));
  return {
    res: `${o.frameWidth}x${o.frameHeight}`,
    fps: Math.round(frames / dt),
    kbps: Math.round(((now.bytes - prev.bytes) * 8) / dt / 1000),
    encodeMs: frames ? Math.round(((now.encTime - prev.encTime) / frames) * 1000) : 0,
    limit: o.qualityLimitationReason,
    codec: rep.get(o.codecId)?.mimeType,
    encoder: o.encoderImplementation,
    rttMs: remote?.roundTripTime != null ? Math.round(remote.roundTripTime * 1000) : null,
    lost: remote?.fractionLost != null ? Math.round(remote.fractionLost * 100) : null,
    jitterMs: remote?.jitter != null ? Math.round(remote.jitter * 1000) : null,
    path: local ? `${local.networkType ?? ""} ${local.address ?? ""} ${local.protocol}` : "",
  };
}
// Chẩn đoán qua USB: đo riêng trong 2 giây (không đụng bộ đếm của thanh trạng thái)
window.__acDiag = async () => {
  const keep = lastStats;
  lastStats = null;
  await readStats();
  await new Promise((r) => setTimeout(r, 2000));
  const s = await readStats();
  lastStats = keep;
  return s;
};

async function tuneBitrate() {
  try {
    const p = videoSender.getParameters();
    if (!p.encodings?.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = S.hd ? 8_000_000 : 4_000_000;
    p.encodings[0].maxFramerate = 30;
    p.degradationPreference = "maintain-resolution";
    await videoSender.setParameters(p);
  } catch {}
}

function disconnect(error = "") {
  const conn = pc;
  // Báo AutoCut biết ngay (không phải chờ mạng tự phát hiện)
  try {
    if (dc?.readyState === "open") dc.send(JSON.stringify({ type: "bye" }));
  } catch {}
  pc = null;
  dc = null;
  videoSender = audioSender = null;
  // Đợi chút cho lời "tạm biệt" kịp gửi đi
  setTimeout(() => conn?.close(), 300);
  $("connect").hidden = false;
  $("controls").hidden = true;
  setStatus("Chưa kết nối");
  showErr(error);
}

// Lệnh từ AutoCut (máy tính điều khiển điện thoại)
async function onCommand(m) {
  if (m.cmd === "flip") await flip();
  else if (m.cmd === "ai") await setAi(!!m.on);
  else if (m.cmd === "mic") setMic(!!m.on);
}

async function flip() {
  S.facing = S.facing === "user" ? "environment" : "user";
  store.set("facing", S.facing);
  stopPacking();
  await openCamera(true);
  if (audioSender) await audioSender.replaceTrack(camStream.getAudioTracks()[0] ?? null);
  await refreshOutTrack();
}

async function setAi(on) {
  S.ai = on;
  store.set("ai2", on);
  $("ai").checked = on;
  await refreshOutTrack();
}

function setMic(on) {
  S.mic = on;
  camStream?.getAudioTracks().forEach((t) => (t.enabled = on));
  updateButtons();
  if (dc?.readyState === "open") dc.send(JSON.stringify({ type: "mic", on }));
}

function updateButtons() {
  $("aiBtn").classList.toggle("on", S.ai);
  $("micBtn").classList.toggle("off", !S.mic);
  $("micBtn").querySelector("small").textContent = S.mic ? "Micro" : "Tắt mic";
}

// ---------------------------------------------------------------- tìm máy AutoCut
async function scan() {
  const box = $("found");
  // iPhone: Apple chặn tìm máy bằng broadcast (cần quyền đặc biệt) → dùng mã QR
  if (native?.platform === "ios") {
    box.innerHTML = '<span class="muted">Trên iPhone: bấm <b>📷 Quét mã QR</b> ở trên — hoặc nhập địa chỉ máy tính bằng tay bên dưới.</span>';
    $("scan").hidden = true;
    return;
  }
  box.innerHTML = '<span class="muted">Đang tìm trong mạng Wi-Fi…</span>';
  $("scan").disabled = true;
  // Chạy ở luồng riêng của Java (~1,5 giây)
  await new Promise((r) => setTimeout(r, 30));
  let list = [];
  try {
    list = JSON.parse(native?.discover?.() ?? "[]");
  } catch {}
  $("scan").disabled = false;
  if (!list.length) {
    box.innerHTML = '<span class="muted">Không thấy máy nào. Kiểm tra cùng Wi-Fi và AutoCut đang mở — hoặc nhập địa chỉ bằng tay bên dưới.</span>';
    if (S.host) $("manual").open = true;
    return;
  }
  box.innerHTML = "";
  for (const pcInfo of list) {
    const b = document.createElement("button");
    b.className = "pc";
    b.innerHTML = `<span>💻 ${escapeHtml(pcInfo.name || pcInfo.ip)}</span><small>${pcInfo.ip}</small>`;
    b.onclick = () => pick(pcInfo, b);
    box.appendChild(b);
    if (pcInfo.ip === S.host || list.length === 1) pick(pcInfo, b);
  }
}

function pick(info, btn) {
  S.host = info.ip;
  S.port = info.port || 39391;
  S.hostName = info.name || info.ip;
  $("host").value = S.host;
  $("port").value = S.port;
  document.querySelectorAll(".pc").forEach((x) => x.classList.toggle("on", x === btn));
}

// ---------------------------------------------------------------- quét mã QR
// Mã QR trên AutoCut: http://<ip>:<cổng>/pair?h=<ip1,ip2…>&p=<cổng>&c=<mã 6 số>
// (mở từ trình duyệt / camera thường thì thành autocut://pair?… — cùng tham số)
let scanning = false;

function parsePairLink(text) {
  try {
    const u = new URL(String(text).trim());
    if (!/^(https?|autocut):$/.test(u.protocol)) return null;
    const ips = (u.searchParams.get("h") || "").split(",").filter((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip));
    const port = Number(u.searchParams.get("p")) || 39391;
    const code = u.searchParams.get("c") || "";
    if (!ips.length || !/^\d{6}$/.test(code)) return null;
    return { ips, port, code };
  } catch {
    return null;
  }
}

/** Máy tính có nhiều địa chỉ (Wi-Fi, dây, máy ảo…) → thử tất cả, lấy địa chỉ trả lời trước. */
async function findReachable(ips, port) {
  const tries = ips.map(async (ip) => {
    const r = await http(`http://${ip}:${port}/phone/hello`, { timeout: 3000 });
    if (!r.ok) throw new Error();
    const j = await r.json();
    return { ip, port, name: j.name || ip };
  });
  return Promise.any(tries).catch(() => null);
}

async function usePairLink(text) {
  const link = parsePairLink(text);
  if (!link) return false;
  if (pc || connecting) return true;
  stopScan();
  showErr("");
  setStatus("Đang tìm máy tính…", "wait");
  const pcInfo = await findReachable(link.ips, link.port);
  if (!pcInfo) {
    setStatus("Chưa kết nối");
    showErr(`Không tới được máy tính (${link.ips.join(", ")}:${link.port}).\nKiểm tra: cùng Wi-Fi, AutoCut đang mở, tường lửa Windows cho phép AutoCut / Node.js (mạng riêng tư).`);
    return true;
  }
  S.hostName = pcInfo.name;
  $("host").value = pcInfo.ip;
  $("port").value = pcInfo.port;
  $("code").value = link.code;
  await connect();
  return true;
}

async function startScan() {
  if (scanning || pc) return;
  showErr("");
  if (!window.jsQR) return showErr("Thiếu bộ đọc mã QR — cài lại app.");
  scanning = true;
  $("connect").hidden = true;
  $("scanner").hidden = false;
  $("scanHint").textContent = "Hướng camera vào mã QR trên AutoCut (tab 📷 Camera)";
  // Quét bằng camera sau; xong việc kết nối sẽ mở lại camera đã chọn
  const keep = S.facing;
  S.facing = "environment";
  try {
    await openCamera();
  } catch (e) {
    S.facing = keep;
    stopScan();
    return showErr(e.message);
  }
  S.facing = keep;
  const cv = document.createElement("canvas");
  const cx = cv.getContext("2d", { willReadFrequently: true });
  while (scanning) {
    const vw = preview.videoWidth;
    const vh = preview.videoHeight;
    if (vw) {
      const k = Math.min(1, 640 / Math.max(vw, vh));
      cv.width = Math.round(vw * k);
      cv.height = Math.round(vh * k);
      cx.drawImage(preview, 0, 0, cv.width, cv.height);
      const img = cx.getImageData(0, 0, cv.width, cv.height);
      const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      if (r?.data) {
        if (await usePairLink(r.data)) return;
        $("scanHint").textContent = "Mã này không phải của AutoCut — quét mã trong tab 📷 Camera → 📱 Điện thoại";
      }
    }
    await new Promise((res) => setTimeout(res, 120));
  }
}

function stopScan() {
  scanning = false;
  $("scanner").hidden = true;
  if (!pc) $("connect").hidden = false;
}

/** Mở app từ link (quét QR bằng camera thường → trang AutoCut → "Mở app & kết nối"). */
window.onPairLink = () => {
  const link = native?.takeLink?.();
  if (link) usePairLink(link);
};

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------------------------------------------------------------- khởi động
$("host").value = S.host;
$("port").value = S.port;
$("code").value = S.code;
$("ai").checked = S.ai;
$("hd").checked = S.hd;
$("scan").onclick = scan;
$("go").onclick = connect;
$("stop").onclick = () => disconnect();
$("flip").onclick = flip;
$("aiBtn").onclick = () => setAi(!S.ai);
$("micBtn").onclick = () => setMic(!S.mic);
$("code").addEventListener("keydown", (e) => e.key === "Enter" && connect());
$("qrBtn").onclick = startScan;
$("qrCancel").onclick = () => {
  stopScan();
  openCamera().catch(() => {});
};
// Tick "Xoá phông" → nạp sẵn AI (mô hình ~16MB) để lúc kết nối không phải chờ
$("ai").addEventListener("change", (e) => e.target.checked && loadSegmenter().catch((err) => showErr(`Không tải được AI xoá phông: ${err.message}`)));
// Nút Back của Android: đang phát thì hỏi trước khi thoát
window.onBack = () => {
  if (scanning) {
    stopScan();
    openCamera().catch(() => {});
    return true;
  }
  if (pc) {
    if (confirm("Ngắt kết nối camera?")) disconnect();
    return true;
  }
  return false;
};
window.onNativePermissions = (ok) => ok && openCamera().catch(() => {});
// Quay lại app (mở khoá màn hình / từ app khác) → camera có thể đã bị hệ thống thu hồi → mở lại
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  const dead = !camStream?.getVideoTracks().some((t) => t.readyState === "live");
  if (dead) {
    openCamera(true)
      .then(async () => {
        if (pc && audioSender) await audioSender.replaceTrack(camStream.getAudioTracks()[0] ?? null);
        if (pc) await refreshOutTrack();
      })
      .catch((e) => showErr(e.message));
  }
});

openCamera()
  .catch((e) => showErr(`Không mở được camera: ${e.message}`))
  // App được mở từ link ghép đôi → kết nối luôn
  .then(() => window.onPairLink());
scan();
if (S.ai) loadSegmenter().catch(() => {});
