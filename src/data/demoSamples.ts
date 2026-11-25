import {
  WATERMARK_TEMPLATES,
  sampleTemplateAlpha,
} from '../engines/fast/templates';
import type { DemoSampleMeta, WatermarkTemplateId } from '../types';

/** 内置 3 张纯 Canvas 程序化演示样图元信息（使用真实平台标定模板合成角标，随时可体验精准识别与无痕修复） */
export const DEMO_SAMPLES: ReadonlyArray<DemoSampleMeta> = [
  {
    id: 'cyber-neon-jimeng',
    title: '赛博霓虹夜景（即梦AI水印）',
    subtitle: '暗调霓虹光影与雨夜倒影 · 右下角真实「即梦AI」半透明角标',
    fileName: '赛博霓虹夜景_即梦AI.png',
    width: 1280,
    height: 720,
    recommendedPresetId: 'jimeng-br',
  },
  {
    id: 'sunset-mountains-kling',
    title: '落日云海山峦（可灵AI水印）',
    subtitle: '暖色霞光层峦与云海光影 · 右下角真实「可灵AI」角标',
    fileName: '落日云海山峦_可灵AI.png',
    width: 1280,
    height: 720,
    recommendedPresetId: 'kling-br',
  },
  {
    id: 'minimal-arch-kling-dual',
    title: '极简光影建筑（豆包AI生成水印）',
    subtitle: '现代极简光影与建筑纹理 · 右下角真实「豆包AI生成」描边角标',
    fileName: '极简光影建筑_豆包AI生成.png',
    width: 1024,
    height: 1024,
    recommendedPresetId: 'doubao-br',
  },
];

/** 使用已标定的真实平台 Alpha 模板按官方短边比例将角标合成到画布右下角 */
function stampRealTemplateWatermark(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  templateId: WatermarkTemplateId,
): void {
  const tpl = WATERMARK_TEMPLATES[templateId];
  const shortSide = Math.min(w, h);
  const scale = shortSide / tpl.referenceShortSide;
  const mw = Math.round(tpl.width * scale);
  const mh = Math.round(tpl.height * scale);
  const mx = w - mw - Math.round(tpl.right * scale);
  const my = h - mh - Math.round(tpl.bottom * scale);
  if (mx < 0 || my < 0 || mx + mw > w || my + mh > h) return;

  const patch = ctx.getImageData(mx, my, mw, mh);
  const d = patch.data;

  // 若为豆包带深色描边样式，先叠加一圈柔和暗边再绘制半透明白字
  if (tpl.hasDarkOutline) {
    const strokeMask = new Float32Array(mw * mh);
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        const tx = ((x + 0.5) * tpl.width) / mw - 0.5;
        const ty = ((y + 0.5) * tpl.height) / mh - 0.5;
        strokeMask[y * mw + x] = sampleTemplateAlpha(tpl, tx, ty) / 255;
      }
    }
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        const selfA = strokeMask[y * mw + x];
        if (selfA >= 0.16) continue;
        let maxNear = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= mh) continue;
          for (let dx = -2; dx <= 2; dx++) {
            if (dx * dx + dy * dy > 4) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= mw) continue;
            const na = strokeMask[ny * mw + nx];
            if (na > maxNear) maxNear = na;
          }
        }
        if (maxNear > 0.18) {
          const darkA = Math.min(0.28, maxNear * 0.45);
          const p = (y * mw + x) * 4;
          d[p] = Math.round(d[p] * (1 - darkA) + 28 * darkA);
          d[p + 1] = Math.round(d[p + 1] * (1 - darkA) + 28 * darkA);
          d[p + 2] = Math.round(d[p + 2] * (1 - darkA) + 28 * darkA);
        }
      }
    }
  }

  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const tx = ((x + 0.5) * tpl.width) / mw - 0.5;
      const ty = ((y + 0.5) * tpl.height) / mh - 0.5;
      const a = sampleTemplateAlpha(tpl, tx, ty) / 255;
      if (a <= 0.002) continue;
      const p = (y * mw + x) * 4;
      d[p] = Math.round(d[p] * (1 - a) + tpl.foreground * a);
      d[p + 1] = Math.round(d[p + 1] * (1 - a) + tpl.foreground * a);
      d[p + 2] = Math.round(d[p + 2] * (1 - a) + tpl.foreground * a);
    }
  }
  ctx.putImageData(patch, mx, my);
}

/** 固定种子的伪随机数生成器，保证每次生成的演示样图画面稳定一致 */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** 1. 绘制「赛博霓虹夜景（即梦AI水印）」 1280×720 */
function drawCyberNeonSample(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = createSeededRandom(202601);

  // 夜空霓虹渐变
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.75);
  sky.addColorStop(0, '#070816');
  sky.addColorStop(0.4, '#141133');
  sky.addColorStop(0.76, '#36174d');
  sky.addColorStop(1, '#75225f');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // 霓虹光晕主光源
  const sunGlow = ctx.createRadialGradient(w * 0.62, h * 0.44, 18, w * 0.62, h * 0.44, 340);
  sunGlow.addColorStop(0, 'rgba(255, 118, 200, 0.72)');
  sunGlow.addColorStop(0.35, 'rgba(139, 92, 246, 0.34)');
  sunGlow.addColorStop(0.7, 'rgba(34, 211, 238, 0.12)');
  sunGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = sunGlow;
  ctx.fillRect(0, 0, w, h);

  // 左侧青色光柱与大气散射
  const cyanGlow = ctx.createRadialGradient(w * 0.24, h * 0.56, 10, w * 0.24, h * 0.56, 280);
  cyanGlow.addColorStop(0, 'rgba(34, 211, 238, 0.42)');
  cyanGlow.addColorStop(0.55, 'rgba(59, 130, 246, 0.14)');
  cyanGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = cyanGlow;
  ctx.fillRect(0, 0, w, h);

  // 星空微光点
  for (let i = 0; i < 110; i++) {
    const sx = rand() * w;
    const sy = rand() * h * 0.46;
    const r = 0.6 + rand() * 1.4;
    ctx.fillStyle = `rgba(226, 232, 240, ${(0.25 + rand() * 0.65).toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 远景建筑剪影层
  const horizonY = Math.round(h * 0.68);
  ctx.fillStyle = '#14122d';
  let x = 0;
  while (x < w) {
    const bw = 38 + Math.floor(rand() * 58);
    const bh = 90 + Math.floor(rand() * 210);
    ctx.fillRect(x, horizonY - bh, bw - 3, bh);
    x += bw;
  }

  // 中景高楼与霓虹窗格
  const buildings: Array<{ x: number; w: number; h: number; accent: string }> = [];
  let bx = -10;
  while (bx < w + 20) {
    const bw = 54 + Math.floor(rand() * 76);
    const bh = 120 + Math.floor(rand() * 255);
    const accent = rand() > 0.48 ? '#22d3ee' : '#f472b6';
    buildings.push({ x: bx, w: bw, h: bh, accent });
    bx += bw - 6;
  }

  for (const b of buildings) {
    const topY = horizonY - b.h;
    const grad = ctx.createLinearGradient(b.x, topY, b.x, horizonY);
    grad.addColorStop(0, '#0d1024');
    grad.addColorStop(1, '#1a183b');
    ctx.fillStyle = grad;
    ctx.fillRect(b.x, topY, b.w - 4, b.h);

    // 楼顶霓虹灯带
    ctx.fillStyle = b.accent;
    ctx.globalAlpha = 0.72;
    ctx.fillRect(b.x + 2, topY + 2, b.w - 8, 2.5);
    ctx.globalAlpha = 1;

    // 窗户网格灯光
    const cols = Math.max(2, Math.floor((b.w - 16) / 11));
    const rows = Math.max(4, Math.floor((b.h - 24) / 14));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (rand() > 0.62) {
          const wx = b.x + 8 + c * 11;
          const wy = topY + 14 + r * 14;
          const warm = rand() > 0.75;
          ctx.fillStyle = warm
            ? `rgba(253, 224, 71, ${(0.35 + rand() * 0.45).toFixed(2)})`
            : rand() > 0.5
              ? `rgba(56, 189, 248, ${(0.3 + rand() * 0.55).toFixed(2)})`
              : `rgba(244, 114, 182, ${(0.3 + rand() * 0.5).toFixed(2)})`;
          ctx.fillRect(wx, wy, 5, 7);
        }
      }
    }
  }

  // 雨夜潮湿地面与霓虹拉丝倒影
  const groundGrad = ctx.createLinearGradient(0, horizonY, 0, h);
  groundGrad.addColorStop(0, '#171330');
  groundGrad.addColorStop(0.5, '#0e1022');
  groundGrad.addColorStop(1, '#090b17');
  ctx.fillStyle = groundGrad;
  ctx.fillRect(0, horizonY, w, h - horizonY);

  // 水平霓虹反射条纹（特意延伸至右下角，验证背景纹理自然修复能力）
  for (let i = 0; i < 64; i++) {
    const ry = horizonY + 8 + rand() * (h - horizonY - 14);
    const rx = rand() * w;
    const rw = 40 + rand() * 160;
    const isCyan = rand() > 0.45;
    const barGrad = ctx.createLinearGradient(rx, ry, rx + rw, ry);
    const col = isCyan ? '34, 211, 238' : '244, 114, 182';
    const alpha = (0.06 + rand() * 0.16).toFixed(2);
    barGrad.addColorStop(0, `rgba(${col}, 0)`);
    barGrad.addColorStop(0.5, `rgba(${col}, ${alpha})`);
    barGrad.addColorStop(1, `rgba(${col}, 0)`);
    ctx.fillStyle = barGrad;
    ctx.fillRect(rx, ry, rw, 2 + rand() * 3.5);
  }

  // 右下角增加一处柔和的蓝紫地标光斑，使水印区域背景更具层次感
  const cornerGlow = ctx.createRadialGradient(w * 0.9, h * 0.92, 10, w * 0.9, h * 0.92, 220);
  cornerGlow.addColorStop(0, 'rgba(99, 102, 241, 0.28)');
  cornerGlow.addColorStop(0.6, 'rgba(34, 211, 238, 0.1)');
  cornerGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = cornerGlow;
  ctx.fillRect(w * 0.65, h * 0.68, w * 0.35, h * 0.32);

  // 使用标定的真实即梦AI模板合成右下角水印
  stampRealTemplateWatermark(ctx, w, h, 'jimeng');
}

/** 2. 绘制「落日云海山峦（可灵AI水印）」 1280×720 */
function drawSunsetMountainsSample(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = createSeededRandom(202602);

  // 层次丰富的暖色霞光天空
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.72);
  sky.addColorStop(0, '#1a2146');
  sky.addColorStop(0.28, '#4e3366');
  sky.addColorStop(0.55, '#b64d62');
  sky.addColorStop(0.8, '#ed8d5c');
  sky.addColorStop(1, '#ffd48c');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // 落日光轮与散射晕圈
  const sunX = w * 0.34;
  const sunY = h * 0.45;
  const sunHalo = ctx.createRadialGradient(sunX, sunY, 12, sunX, sunY, 320);
  sunHalo.addColorStop(0, 'rgba(255, 248, 220, 0.92)');
  sunHalo.addColorStop(0.18, 'rgba(255, 212, 138, 0.62)');
  sunHalo.addColorStop(0.5, 'rgba(249, 115, 22, 0.2)');
  sunHalo.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = sunHalo;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = 'rgba(255, 247, 226, 0.9)';
  ctx.beginPath();
  ctx.arc(sunX, sunY, 36, 0, Math.PI * 2);
  ctx.fill();

  // 高空柔光流云
  for (let i = 0; i < 18; i++) {
    const cx = rand() * w;
    const cy = h * 0.1 + rand() * h * 0.34;
    const rx = 85 + rand() * 165;
    const ry = 10 + rand() * 18;
    const cGrad = ctx.createLinearGradient(cx - rx, cy, cx + rx, cy);
    cGrad.addColorStop(0, 'rgba(255, 215, 170, 0)');
    cGrad.addColorStop(0.5, `rgba(255, 214, 165, ${(0.14 + rand() * 0.2).toFixed(2)})`);
    cGrad.addColorStop(1, 'rgba(255, 215, 170, 0)');
    ctx.fillStyle = cGrad;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 四层远近山脊 + 山谷云雾
  const drawMountainLayer = (
    baseY: number,
    amp: number,
    freq: number,
    phase: number,
    topColor: string,
    bottomColor: string,
  ) => {
    const evalRidgeY = (x: number) =>
      baseY -
      (Math.sin(x * freq + phase) * amp +
        Math.sin(x * freq * 2.1 + phase * 1.7) * (amp * 0.42) +
        Math.cos(x * freq * 0.52 + phase * 0.5) * (amp * 0.36));

    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x < w; x += 12) {
      ctx.lineTo(x, evalRidgeY(x));
    }
    // 显式补齐 x = w 右边界顶点，避免宽度非步长整数倍时斜切留出天空亮缝
    ctx.lineTo(w, evalRidgeY(w));
    ctx.lineTo(w, h);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, baseY - amp * 1.6, 0, h);
    grad.addColorStop(0, topColor);
    grad.addColorStop(1, bottomColor);
    ctx.fillStyle = grad;
    ctx.fill();
  };

  drawMountainLayer(h * 0.56, 46, 0.0042, 0.4, '#8b4d68', '#522f52');

  // 中层霞光云海
  const mist1 = ctx.createLinearGradient(0, h * 0.54, 0, h * 0.72);
  mist1.addColorStop(0, 'rgba(255, 210, 165, 0)');
  mist1.addColorStop(0.5, 'rgba(255, 206, 168, 0.32)');
  mist1.addColorStop(1, 'rgba(255, 210, 165, 0)');
  ctx.fillStyle = mist1;
  ctx.fillRect(0, h * 0.54, w, h * 0.18);

  drawMountainLayer(h * 0.67, 58, 0.0036, 2.2, '#5a3254', '#2e1d3b');
  drawMountainLayer(h * 0.79, 52, 0.005, 4.1, '#312142', '#171329');

  // 前景云海与山谷微光（自然贯穿右下角区域）
  const cloudSea = ctx.createLinearGradient(0, h * 0.76, 0, h);
  cloudSea.addColorStop(0, 'rgba(244, 151, 118, 0.06)');
  cloudSea.addColorStop(0.5, 'rgba(130, 88, 138, 0.24)');
  cloudSea.addColorStop(1, 'rgba(26, 23, 46, 0.88)');
  ctx.fillStyle = cloudSea;
  ctx.fillRect(0, h * 0.76, w, h * 0.24);

  for (let i = 0; i < 24; i++) {
    const cx = rand() * w;
    const cy = h * 0.78 + rand() * h * 0.2;
    const rx = 90 + rand() * 190;
    const ry = 14 + rand() * 26;
    const puff = ctx.createRadialGradient(cx, cy, 4, cx, cy, rx);
    puff.addColorStop(0, `rgba(255, 210, 178, ${(0.08 + rand() * 0.14).toFixed(2)})`);
    puff.addColorStop(1, 'rgba(255, 210, 178, 0)');
    ctx.fillStyle = puff;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 使用标定的真实可灵AI模板合成右下角水印
  stampRealTemplateWatermark(ctx, w, h, 'kling');
}

/** 3. 绘制「极简光影建筑（KLING双角水印）」 1024×1024 */
function drawMinimalArchSample(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = createSeededRandom(202603);

  // 干净澄澈的浅灰蓝天空底
  const sky = ctx.createLinearGradient(0, 0, w, h * 0.55);
  sky.addColorStop(0, '#c8d6e5');
  sky.addColorStop(0.55, '#dde4ec');
  sky.addColorStop(1, '#ede8df');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // 主体现代极简混凝土建筑墙面（右侧受光，左侧阴影）
  const wallGrad = ctx.createLinearGradient(0, h * 0.16, w, h);
  wallGrad.addColorStop(0, '#e8e2d7');
  wallGrad.addColorStop(0.5, '#d5cdc0');
  wallGrad.addColorStop(1, '#bfb5a6');
  ctx.fillStyle = wallGrad;
  ctx.fillRect(0, h * 0.22, w, h * 0.78);

  // 右上倾斜建筑翼面与蓝灰天空留白
  ctx.fillStyle = '#334155';
  ctx.beginPath();
  ctx.moveTo(0, h * 0.22);
  ctx.lineTo(w * 0.62, h * 0.08);
  ctx.lineTo(w * 0.62, h * 0.28);
  ctx.lineTo(0, h * 0.36);
  ctx.closePath();
  ctx.fill();

  // 左上角深色屋檐投影（衬托「AI生成」浅色文字）
  const eaveGrad = ctx.createLinearGradient(0, 0, w * 0.4, h * 0.24);
  eaveGrad.addColorStop(0, '#1e293b');
  eaveGrad.addColorStop(1, '#334155');
  ctx.fillStyle = eaveGrad;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(w * 0.48, 0);
  ctx.lineTo(w * 0.34, h * 0.19);
  ctx.lineTo(0, h * 0.24);
  ctx.closePath();
  ctx.fill();

  // 三个极简拱门光影几何体
  const archPositions = [0.22, 0.52, 0.82];
  for (const ratio of archPositions) {
    const cx = w * ratio;
    const archW = w * 0.18;
    const archH = h * 0.36;
    const archTop = h * 0.42;

    // 拱洞内部深影
    const inner = ctx.createLinearGradient(
      cx - archW / 2,
      archTop,
      cx + archW / 2,
      archTop + archH,
    );
    inner.addColorStop(0, '#263042');
    inner.addColorStop(1, '#475569');
    ctx.fillStyle = inner;
    ctx.beginPath();
    ctx.arc(cx, archTop + archW / 2, archW / 2, Math.PI, 0);
    ctx.lineTo(cx + archW / 2, archTop + archH);
    ctx.lineTo(cx - archW / 2, archTop + archH);
    ctx.closePath();
    ctx.fill();

    // 拱门内侧受光切面
    ctx.fillStyle = 'rgba(241, 234, 222, 0.38)';
    ctx.beginPath();
    ctx.arc(cx + 8, archTop + archW / 2, archW / 2 - 4, Math.PI * 1.05, Math.PI * 1.85);
    ctx.lineTo(cx + archW / 2 - 2, archTop + archH);
    ctx.lineTo(cx + archW / 2 - 18, archTop + archH);
    ctx.closePath();
    ctx.fill();
  }

  // 斜射暖阳与建筑几何长投影
  const floorY = h * 0.78;
  const floorGrad = ctx.createLinearGradient(0, floorY, 0, h);
  floorGrad.addColorStop(0, '#9e9588');
  floorGrad.addColorStop(1, '#6f6960');
  ctx.fillStyle = floorGrad;
  ctx.fillRect(0, floorY, w, h - floorY);

  // 左下斜向深灰投影带
  ctx.fillStyle = 'rgba(30, 41, 59, 0.48)';
  ctx.beginPath();
  ctx.moveTo(0, floorY);
  ctx.lineTo(w * 0.66, floorY);
  ctx.lineTo(w * 0.42, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();

  // 斜向阳光高光带
  const beam = ctx.createLinearGradient(w * 0.4, h * 0.22, w * 0.92, h);
  beam.addColorStop(0, 'rgba(255, 249, 235, 0.24)');
  beam.addColorStop(0.5, 'rgba(255, 245, 220, 0.14)');
  beam.addColorStop(1, 'rgba(255, 245, 220, 0)');
  ctx.fillStyle = beam;
  ctx.beginPath();
  ctx.moveTo(w * 0.42, h * 0.22);
  ctx.lineTo(w * 0.78, h * 0.22);
  ctx.lineTo(w, h * 0.72);
  ctx.lineTo(w * 0.68, h);
  ctx.closePath();
  ctx.fill();

  // 极细微建筑肌理颗粒，使画面更具摄影质感
  for (let i = 0; i < 1600; i++) {
    const px = rand() * w;
    const py = rand() * h;
    const light = rand() > 0.5;
    ctx.fillStyle = light ? 'rgba(255,255,255,0.035)' : 'rgba(15,23,42,0.035)';
    ctx.fillRect(px, py, 2, 2);
  }

  // 使用标定的真实豆包AI生成模板合成右下角水印
  stampRealTemplateWatermark(ctx, w, h, 'doubao');
}

/** 将指定演示样图渲染至离屏 Canvas */
export function renderDemoSampleToCanvas(id: string): HTMLCanvasElement {
  const meta = DEMO_SAMPLES.find((item) => item.id === id);
  if (!meta) {
    throw new Error(`未找到编号为「${id}」的内置演示样图`);
  }

  const canvas = document.createElement('canvas');
  canvas.width = meta.width;
  canvas.height = meta.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('当前浏览器环境不支持 Canvas 2D 渲染');
  }

  switch (meta.id) {
    case 'cyber-neon-jimeng':
      drawCyberNeonSample(ctx, meta.width, meta.height);
      break;
    case 'sunset-mountains-kling':
      drawSunsetMountainsSample(ctx, meta.width, meta.height);
      break;
    case 'minimal-arch-kling-dual':
      drawMinimalArchSample(ctx, meta.width, meta.height);
      break;
  }

  return canvas;
}

/** 将 Canvas 异步导出为 PNG File 对象 */
function canvasToPngFile(canvas: HTMLCanvasElement, fileName: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error(`生成演示样图「${fileName}」失败`));
        return;
      }
      resolve(new File([blob], fileName, { type: 'image/png', lastModified: Date.now() }));
    }, 'image/png');
  });
}

/** 加载单张内置演示样图并返回可直接导入队列的 File 对象 */
export async function loadDemoSample(id: string): Promise<File> {
  const meta = DEMO_SAMPLES.find((item) => item.id === id);
  if (!meta) {
    throw new Error(`未找到编号为「${id}」的内置演示样图`);
  }
  const canvas = renderDemoSampleToCanvas(id);
  return canvasToPngFile(canvas, meta.fileName);
}

/** 批量生成全部 3 张内置演示样图 File 对象 */
export async function loadAllDemoSamples(): Promise<File[]> {
  return Promise.all(DEMO_SAMPLES.map((sample) => loadDemoSample(sample.id)));
}
