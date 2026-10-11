// AI xoá phông chạy ở luồng riêng: luồng chính chỉ vẽ + gửi hình nên luôn đủ 30 khung/giây.
// Nhận ảnh nhỏ (ImageBitmap) → trả mặt nạ người (ảnh xám RGBA) để vẽ vào khung ghép.
/* global importScripts, Vision */
importScripts("./vision_bundle.js");

let segmenter = null;
let prev = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") {
    try {
      const fileset = await Vision.FilesetResolver.forVisionTasks(new URL("./wasm", self.location.href).href);
      segmenter = await Vision.ImageSegmenter.createFromOptions(fileset, {
        // Mô hình nhẹ; CPU (WebAssembly) ở luồng riêng — không phải chờ card đồ hoạ đang bận mã hoá video
        baseOptions: { modelAssetPath: new URL("./models/selfie_segmenter.tflite", self.location.href).href, delegate: "CPU" },
        runningMode: "VIDEO",
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
    }
    return;
  }
  if (m.type === "frame") {
    const bmp = m.bmp;
    if (!segmenter) return bmp.close();
    const t = performance.now();
    const res = segmenter.segmentForVideo(bmp, m.ts);
    try {
      const mask = res.confidenceMasks && res.confidenceMasks[0];
      if (!mask) return self.postMessage({ type: "skip" });
      const conf = mask.getAsFloat32Array();
      const w = mask.width;
      const h = mask.height;
      if (!prev || prev.length !== conf.length) prev = new Float32Array(conf.length);
      const out = new Uint8ClampedArray(conf.length * 4);
      for (let i = 0; i < conf.length; i++) {
        // Làm mượt theo thời gian để viền không nhấp nháy
        const v = prev[i] * 0.3 + conf[i] * 0.7;
        prev[i] = v;
        const g = v * 255;
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g;
        out[i * 4 + 3] = 255;
      }
      self.postMessage({ type: "mask", w, h, data: out, ms: performance.now() - t }, [out.buffer]);
    } finally {
      res.close();
      bmp.close();
    }
  }
};
