const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const { writeFileSync, readFileSync, mkdtempSync, rmSync } = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const ffmpegStaticPath = require("ffmpeg-static");
const FFMPEG_BIN = ffmpegStaticPath || "ffmpeg";
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const { ensureCached } = require("./lib/canvas-common");

const FONT_URL = "https://cdn.jsdelivr.net/gh/google/fonts/ofl/anton/Anton-Regular.ttf";
const FONT_FAMILY = "AntonBrat";

let fontReady = false;

async function ensureFont() {
  if (fontReady) return;
  const fontLocal = await ensureCached(FONT_URL, "bratvid3_anton.ttf");
  GlobalFonts.registerFromPath(fontLocal, FONT_FAMILY);
  fontReady = true;
}

function tokenize(text) {
  return text.split(/\s+/).filter(Boolean);
}

function wrapText(ctx, text, maxWidth, fontSize) {
  ctx.font = `${fontSize}px ${FONT_FAMILY}`;
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  for (const word of words) {
    const test = cur ? cur + " " + word : word;
    if (ctx.measureText(test).width > maxWidth && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function fitsAt(ctx, text, fontSize, maxWidth, maxHeight, lineGap) {
  const lines = wrapText(ctx, text, maxWidth, fontSize);
  const longestWord = Math.max(...text.split(" ").map(w => ctx.measureText(w).width));
  const totalHeight = lines.length * (fontSize + lineGap) - lineGap;
  return longestWord <= maxWidth && totalHeight <= maxHeight;
}

function findBestFontSize(ctx, text, maxWidth, maxHeight, lineGap) {
  let lo = 10, hi = 400, best = lo;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fitsAt(ctx, text, mid, maxWidth, maxHeight, lineGap)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

const THEMES = {
  black: { bg: "#000000", text: "#ffffff", flare: "255,255,255", composite: "lighter" },
  white: { bg: "#ffffff", text: "#000000", flare: "0,0,0", composite: "source-over" }
};

function drawFlare(ctx, cx, cy, progress, maxRadius, theme) {
  const alpha = Math.sin(Math.min(1, Math.max(0, progress)) * Math.PI); // 0 -> 1 -> 0
  if (alpha <= 0.01) return;
  const radius = maxRadius * (0.35 + progress * 0.65);

  ctx.save();
  ctx.globalCompositeOperation = theme.composite;

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  grad.addColorStop(0, `rgba(${theme.flare},${0.95 * alpha})`);
  grad.addColorStop(0.15, `rgba(${theme.flare},${0.65 * alpha})`);
  grad.addColorStop(0.4, `rgba(${theme.flare},${0.28 * alpha})`);
  grad.addColorStop(1, `rgba(${theme.flare},0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = `rgba(${theme.flare},${0.5 * alpha})`;
  ctx.lineWidth = 2;
  const rayCount = 8;
  const rayLen = radius * 1.7;
  for (let i = 0; i < rayCount; i++) {
    const angle = (i / rayCount) * Math.PI * 2 + progress * 0.6;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(angle) * rayLen * 0.15, cy - Math.sin(angle) * rayLen * 0.15);
    ctx.lineTo(cx + Math.cos(angle) * rayLen, cy + Math.sin(angle) * rayLen);
    ctx.stroke();
  }
  ctx.restore();
}

async function renderFrame({ lines, fontSize, lineGap, margin, boxSize, flareProgress, theme }) {
  const size = 1000;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, size, size);

  if (lines.length) {
    const totalTextHeight = lines.length * (fontSize + lineGap) - lineGap;
    const startY = margin + (boxSize - totalTextHeight) / 2;

    ctx.fillStyle = theme.text;
    ctx.font = `${fontSize}px ${FONT_FAMILY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    lines.forEach((line, i) => {
      ctx.fillText(line, size / 2, startY + i * (fontSize + lineGap));
    });

    if (flareProgress != null) {
      const cx = size / 2;
      const cy = margin + boxSize / 2;
      drawFlare(ctx, cx, cy, flareProgress, boxSize * 0.75, theme);
    }
  }

  return canvas.encode("png");
}

async function generateBratVideo3({ text, wordsPerChunk = 2, holdDuration = 1.5, fastProgress = true, format = "mp4", bg = "black" }) {
  await ensureFont();
  const theme = THEMES[bg] || THEMES.black;

  if (!text.trim()) throw new Error("Teks kosong");

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "brat3-"));

  try {
    const FPS = 30;
    const frameTime = 1 / FPS;
    const FLARE_FRAMES = 8;
    const HOLD_FRAMES = 10;

    const size = 1000;
    const margin = 90;
    const padding = 30;
    const boxSize = size - margin * 2;
    const lineGap = 14;
    const maxWidth = boxSize - padding * 2;
    const maxHeight = boxSize - padding * 2;

    const dummyCanvas = createCanvas(size, size);
    const dummyCtx = dummyCanvas.getContext("2d");

    const words = tokenize(text);
    const chunks = [];
    for (let i = wordsPerChunk; i < words.length; i += wordsPerChunk) {
      chunks.push(words.slice(0, i).join(" "));
    }
    chunks.push(words.join(" "));

    const fullFontSize = findBestFontSize(dummyCtx, words.join(" "), maxWidth, maxHeight, lineGap);

    const tasks = [];

    chunks.forEach((chunkText, idx) => {
      const lines = wrapText(dummyCtx, chunkText, maxWidth, fullFontSize);
      const isLast = idx === chunks.length - 1;

      for (let f = 0; f < FLARE_FRAMES; f++) {
        tasks.push({ lines, fontSize: fullFontSize, lineGap, margin, boxSize, flareProgress: f / (FLARE_FRAMES - 1), theme, duration: frameTime });
      }

      const holdFrames = isLast ? Math.round(holdDuration * FPS) : HOLD_FRAMES;
      for (let f = 0; f < holdFrames; f++) {
        tasks.push({ lines, fontSize: fullFontSize, lineGap, margin, boxSize, flareProgress: null, theme, duration: frameTime });
      }
    });

    const renderTask = async (task, index) => {
      const buffer = await renderFrame(task);
      const framePath = path.join(tmpDir, `frame-${String(index + 1).padStart(5, "0")}.png`);
      writeFileSync(framePath, buffer);
      return { path: framePath, duration: task.duration };
    };

    let framePaths;
    if (fastProgress) {
      framePaths = await Promise.all(tasks.map((t, i) => renderTask(t, i)));
    } else {
      framePaths = [];
      for (let i = 0; i < tasks.length; i++) framePaths.push(await renderTask(tasks[i], i));
    }

    const manifestLines = [];
    for (let i = 0; i < framePaths.length; i++) {
      manifestLines.push(`file '${framePaths[i].path.replace(/'/g, "'\\''")}'`);
      manifestLines.push(`duration ${framePaths[i].duration}`);
    }
    manifestLines.push(`file '${framePaths[framePaths.length - 1].path.replace(/'/g, "'\\''")}'`);

    const concatPath = path.join(tmpDir, "concat.txt");
    writeFileSync(concatPath, manifestLines.join("\n"));

    const ext = format === "gif" ? "gif" : "mp4";
    const outPath = path.join(tmpDir, `bratvid3-${Date.now()}.${ext}`);

    if (format === "gif") {
      await execFileAsync(FFMPEG_BIN, [
        "-y", "-f", "concat", "-safe", "0", "-i", concatPath,
        "-vf", "fps=30,scale=1000:1000:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=bayer",
        "-loop", "0", outPath
      ]);
    } else {
      await execFileAsync(FFMPEG_BIN, [
        "-y", "-f", "concat", "-safe", "0", "-i", concatPath,
        "-vf", "scale=1000:1000", "-c:v", "libx264", "-preset", "fast",
        "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outPath
      ]);
    }

    const buffer = readFileSync(outPath);
    return { buffer, ext };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = {
  name: "Brat Video V3 (Flash/Lens Flare)",
  desc: "Video/GIF teks brat-style latar hitam atau putih (pilih lewat bg=black/white, teks otomatis kontras), tambah baris demi baris, diiringi flash/lens-flare terang tiap baris baru muncul. Cukup isi teksnya aja.",
  category: "Image Creator",
  path: "/api/canvas/bratvid3?apikey=&text=&bg=black",
  async run(req, res) {
    const { apikey, text, format, bg } = req.query;
    const bgChoice = String(bg || "black").toLowerCase() === "white" ? "white" : "black";

    if (!apikey || !global.apikey.includes(apikey)) {
      return res.status(401).json({ status: false, error: "Apikey invalid atau tidak terdaftar" });
    }
    if (!text) {
      return res.status(400).json({ status: false, error: "Parameter 'text' wajib diisi" });
    }

    try {
      const { buffer, ext } = await generateBratVideo3({
        text,
        format: format === "gif" ? "gif" : "mp4",
        bg: bgChoice
      });

      res.writeHead(200, {
        "Content-Type": ext === "gif" ? "image/gif" : "video/mp4",
        "Content-Length": buffer.length
      });
      return res.end(buffer);
    } catch (error) {
      console.error("Bratvid3 Error:", error.message);
      return res.status(500).json({
        status: false,
        error: "Gagal generate brat video v3. Pastikan binary ffmpeg tersedia di server ini."
      });
    }
  }
};
