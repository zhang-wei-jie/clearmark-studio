/**
 * 纯前端零依赖轻量去水印核心算法（无马赛克 · 像素级无损保留非遮罩区）
 *
 * 流水线设计：
 * 1. 紧凑连通区域分块：按遮罩膨胀邻域拆分为独立局部 ROI（仅保留 18~52px 周边背景），
 *    避免远处无关景物干扰，兼顾 4K 大图与双角水印处理速度，非遮罩区 100% 字节级无损。
 * 2. 阶段一（标准 Telea Fast Marching 填充）：基于二值最小堆求解 2D 程函方程并从边界向内填充，
 *    支持预乘 RGB 与透明通道（PNG/WebP）独立修补，严格限制边界色域杜绝色条过冲。
 * 3. 阶段二（收敛型拉普拉斯调和融合）：在遮罩内求解离散拉普拉斯方程 ∇²I = 0，
 *    固定边界像素使明暗与色彩渐变自然穿过选区，彻底消除 FMM 中轴折痕与块状马赛克。
 * 4. 阶段三（半透明笔画高频细节逆向补偿与邻近微纹理回填）：
 *    - 命中已知半透明平台模板（如即梦、豆包）时，在稳定笔画内部利用物理混合比例 1/(1-α) 补偿底层真实高频微细节；
 *    - 不透明笔画及手动选区借用邻近同色干净背景的限幅拉普拉斯微纹理，避免平滑涂抹塑料感。
 */

import type { FastQuality, MatchedWatermark } from '../../types';
import { WATERMARK_TEMPLATES, sampleMatchedMarkAlpha } from './templates';

/** 核心修补算法运行参数 */
export interface FastInpaintCoreOptions {
  /** 质量档位：'standard'（毫秒级）| 'high'（更高调和收敛精度与扩展微纹理搜索） */
  quality?: FastQuality;
  /** 边缘保边羽化像素半径，默认 3 */
  featherPx?: number;
  /** 已命中的精准平台模板（用于半透明笔画高频细节与逆向还原） */
  matchedMarks?: MatchedWatermark[];
  /** 进度回调 (当前阶段中文说明, 0~100 百分比) */
  onProgress?: (stage: string, percent: number) => void;
  /** 中断检查回调，返回 true 时尽快抛出 AbortError 终止计算 */
  shouldAbort?: () => boolean;
}

/** 同步/异步核心执行结果 */
export interface FastInpaintCoreResult {
  imageData: ImageData;
  durationMs: number;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  holePixels: number;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 构造兼容浏览器与 Vitest/jsdom 的 ImageData 对象 */
export function createImageDataSafe(
  data: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): ImageData {
  if (typeof ImageData !== 'undefined') {
    return new ImageData(data, width, height);
  }
  return {
    data,
    width,
    height,
    colorSpace: 'srgb',
  } as ImageData;
}

/** 创建标准 AbortError，便于上层统一识别任务取消 */
export function createAbortError(message = '去水印任务已取消'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function checkAbort(shouldAbort?: () => boolean): void {
  if (shouldAbort?.()) {
    throw createAbortError();
  }
}

/** 轻量让出事件循环，供异步分片模式与 Worker 及时响应 cancel 消息 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * 将全局遮罩按空间邻近度划分为独立修补簇（双角水印、多处涂抹互不干扰）
 */
export function findMaskClusters(mask: Uint8Array, width: number, height: number): Box[] {
  const tileSize = 24;
  const tilesX = Math.ceil(width / tileSize);
  const tilesY = Math.ceil(height / tileSize);
  const tileActive = new Uint8Array(tilesX * tilesY);

  let totalHole = 0;
  for (let y = 0; y < height; y++) {
    const ty = Math.floor(y / tileSize);
    const rowOff = y * width;
    const tileRowOff = ty * tilesX;
    for (let x = 0; x < width; x++) {
      if (mask[rowOff + x] > 0) {
        tileActive[tileRowOff + Math.floor(x / tileSize)] = 1;
        totalHole++;
      }
    }
  }

  if (totalHole === 0) return [];

  const tileLabel = new Int32Array(tilesX * tilesY);
  const queue = new Int32Array(tilesX * tilesY);
  let labelCount = 0;
  const mergeDist = 2;

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const startIdx = ty * tilesX + tx;
      if (tileActive[startIdx] === 0 || tileLabel[startIdx] !== 0) continue;
      labelCount++;
      let head = 0;
      let tail = 0;
      tileLabel[startIdx] = labelCount;
      queue[tail++] = startIdx;

      while (head < tail) {
        const cur = queue[head++];
        const cx = cur % tilesX;
        const cy = (cur - cx) / tilesX;
        const y0 = Math.max(0, cy - mergeDist);
        const y1 = Math.min(tilesY - 1, cy + mergeDist);
        const x0 = Math.max(0, cx - mergeDist);
        const x1 = Math.min(tilesX - 1, cx + mergeDist);
        for (let ny = y0; ny <= y1; ny++) {
          const nRow = ny * tilesX;
          for (let nx = x0; nx <= x1; nx++) {
            const nIdx = nRow + nx;
            if (tileActive[nIdx] === 1 && tileLabel[nIdx] === 0) {
              tileLabel[nIdx] = labelCount;
              queue[tail++] = nIdx;
            }
          }
        }
      }
    }
  }

  const clusters: Box[] = Array.from({ length: labelCount }, () => ({
    minX: width,
    minY: height,
    maxX: -1,
    maxY: -1,
    holePixels: 0,
  }));

  for (let y = 0; y < height; y++) {
    const ty = Math.floor(y / tileSize);
    const rowOff = y * width;
    const tileRowOff = ty * tilesX;
    for (let x = 0; x < width; x++) {
      if (mask[rowOff + x] > 0) {
        const lbl = tileLabel[tileRowOff + Math.floor(x / tileSize)];
        if (lbl > 0) {
          const box = clusters[lbl - 1];
          if (x < box.minX) box.minX = x;
          if (x > box.maxX) box.maxX = x;
          if (y < box.minY) box.minY = y;
          if (y > box.maxY) box.maxY = y;
          box.holePixels++;
        }
      }
    }
  }

  // 迭代合并所有间距小于紧凑边距的簇，保证传递邻近的多个小簇被完整归并
  const mergeGap = clamp(Math.ceil(32 * Math.max(1, Math.min(width, height) / 1080)), 28, 72);
  const merged: Box[] = clusters.filter((box) => box.holePixels > 0).map((box) => ({ ...box }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      const a = merged[i];
      for (let j = i + 1; j < merged.length; j++) {
        const b = merged[j];
        const gapX = Math.max(0, Math.max(b.minX - a.maxX, a.minX - b.maxX));
        const gapY = Math.max(0, Math.max(b.minY - a.maxY, a.minY - b.maxY));
        if (gapX <= mergeGap && gapY <= mergeGap) {
          a.minX = Math.min(a.minX, b.minX);
          a.minY = Math.min(a.minY, b.minY);
          a.maxX = Math.max(a.maxX, b.maxX);
          a.maxY = Math.max(a.maxY, b.maxY);
          a.holePixels += b.holePixels;
          merged.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  return merged;
}

/** 计算紧凑局部修复窗口（仅需留足 18~52px 周边背景供 Telea、拉普拉斯与邻域纹理借用） */
function computeCompactRoi(
  box: Box,
  imgW: number,
  imgH: number,
): { x0: number; y0: number; w: number; h: number } {
  const padding = clamp(Math.ceil(22 * Math.max(1, Math.min(imgW, imgH) / 1080)), 18, 52);
  const x0 = Math.max(0, box.minX - padding);
  const y0 = Math.max(0, box.minY - padding);
  const x1 = Math.min(imgW - 1, box.maxX + padding);
  const y1 = Math.min(imgH - 1, box.maxY + padding);
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 固定容量二进制最小堆（支持 O(log N) decrease-key，用于 Telea Fast Marching） */
class IndexMinHeap {
  private heap: Int32Array;
  private keys: Float32Array;
  private pos: Int32Array;
  size = 0;

  constructor(maxIndex: number, capacity: number) {
    this.heap = new Int32Array(Math.max(16, capacity));
    this.keys = new Float32Array(Math.max(16, capacity));
    this.pos = new Int32Array(maxIndex);
    this.pos.fill(-1);
  }

  pushOrDecrease(idx: number, key: number): void {
    const existing = this.pos[idx];
    if (existing !== -1) {
      if (key < this.keys[existing]) {
        this.keys[existing] = key;
        this.siftUp(existing);
      }
      return;
    }
    if (this.size >= this.heap.length) {
      const nextCap = this.heap.length * 2;
      const nextHeap = new Int32Array(nextCap);
      const nextKeys = new Float32Array(nextCap);
      nextHeap.set(this.heap);
      nextKeys.set(this.keys);
      this.heap = nextHeap;
      this.keys = nextKeys;
    }
    const i = this.size++;
    this.heap[i] = idx;
    this.keys[i] = key;
    this.pos[idx] = i;
    this.siftUp(i);
  }

  pop(): number {
    const topIdx = this.heap[0];
    this.pos[topIdx] = -1;
    this.size--;
    if (this.size > 0) {
      const lastIdx = this.heap[this.size];
      this.heap[0] = lastIdx;
      this.keys[0] = this.keys[this.size];
      this.pos[lastIdx] = 0;
      this.siftDown(0);
    }
    return topIdx;
  }

  private siftUp(i: number): void {
    let cur = i;
    while (cur > 0) {
      const parent = (cur - 1) >> 1;
      if (this.keys[cur] >= this.keys[parent]) break;
      this.swap(cur, parent);
      cur = parent;
    }
  }

  private siftDown(i: number): void {
    let cur = i;
    const n = this.size;
    while (true) {
      let smallest = cur;
      const left = (cur << 1) + 1;
      const right = left + 1;
      if (left < n && this.keys[left] < this.keys[smallest]) smallest = left;
      if (right < n && this.keys[right] < this.keys[smallest]) smallest = right;
      if (smallest === cur) break;
      this.swap(cur, smallest);
      cur = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const ia = this.heap[a];
    const ib = this.heap[b];
    const ka = this.keys[a];
    const kb = this.keys[b];
    this.heap[a] = ib;
    this.heap[b] = ia;
    this.keys[a] = kb;
    this.keys[b] = ka;
    this.pos[ib] = a;
    this.pos[ia] = b;
  }
}

const FMM_KNOWN = 0;
const FMM_BAND = 1;
const FMM_INSIDE = 2;
const FMM_INF = 1e9;

/** 解 2D 程函方程 |∇T| = 1 */
function solveEikonal(
  x: number,
  y: number,
  w: number,
  h: number,
  state: Uint8Array,
  dist: Float32Array,
): number {
  let tH = FMM_INF;
  if (x > 0) {
    const l = y * w + (x - 1);
    if (state[l] === FMM_KNOWN && dist[l] < tH) tH = dist[l];
  }
  if (x + 1 < w) {
    const r = y * w + (x + 1);
    if (state[r] === FMM_KNOWN && dist[r] < tH) tH = dist[r];
  }

  let tV = FMM_INF;
  if (y > 0) {
    const u = (y - 1) * w + x;
    if (state[u] === FMM_KNOWN && dist[u] < tV) tV = dist[u];
  }
  if (y + 1 < h) {
    const d = (y + 1) * w + x;
    if (state[d] === FMM_KNOWN && dist[d] < tV) tV = dist[d];
  }

  if (tH < FMM_INF && tV < FMM_INF) {
    const diff = tH - tV;
    if (Math.abs(diff) < 1) {
      return 0.5 * (tH + tV + Math.sqrt(Math.max(0, 2 - diff * diff)));
    }
    return Math.min(tH, tV) + 1;
  }
  if (tH < FMM_INF) return tH + 1;
  if (tV < FMM_INF) return tV + 1;
  return FMM_INF;
}

/**
 * 阶段一：标准 Telea Fast Marching 填充（支持 3 通道预乘 RGB 或 1 通道 Alpha）
 * 严格将一阶梯度外推钳位在已知邻域极值内，避免高对比边缘过冲产生彩条。
 */
function runTeleaFmm(
  values: Float32Array,
  channels: 1 | 3,
  mask: Uint8Array,
  w: number,
  h: number,
  holeIndices: Uint32Array,
  radius = 3,
  shouldAbort?: () => boolean,
): void {
  const total = w * h;
  if (holeIndices.length === 0 || holeIndices.length === total) return;

  const state = new Uint8Array(total);
  const dist = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    if (mask[i] > 0) {
      state[i] = FMM_INSIDE;
      dist[i] = FMM_INF;
    } else {
      state[i] = FMM_KNOWN;
      dist[i] = 0;
    }
  }

  const heap = new IndexMinHeap(total, Math.min(total, holeIndices.length + 16));

  for (let k = 0; k < holeIndices.length; k++) {
    const idx = holeIndices[k];
    const x = idx % w;
    const y = (idx - x) / w;
    const touchesKnown =
      (x > 0 && state[idx - 1] === FMM_KNOWN) ||
      (x + 1 < w && state[idx + 1] === FMM_KNOWN) ||
      (y > 0 && state[idx - w] === FMM_KNOWN) ||
      (y + 1 < h && state[idx + w] === FMM_KNOWN);
    if (touchesKnown) {
      state[idx] = FMM_BAND;
      dist[idx] = 1;
      heap.pushOrDecrease(idx, 1);
    }
  }

  const radiusSq = radius * radius;
  const dirOffsets = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const;

  const sumC = new Float64Array(channels);
  const minC = new Float32Array(channels);
  const maxC = new Float32Array(channels);

  let processedSteps = 0;
  while (heap.size > 0) {
    if ((++processedSteps & 4095) === 0) {
      checkAbort(shouldAbort);
    }
    const idx = heap.pop();
    if (state[idx] === FMM_KNOWN) continue;
    const x = idx % w;
    const y = (idx - x) / w;

    // 计算距离场单位梯度用于方向加权
    let gradTx = 0;
    let gradTy = 0;
    const leftKnown = x > 0 && state[idx - 1] === FMM_KNOWN;
    const rightKnown = x + 1 < w && state[idx + 1] === FMM_KNOWN;
    if (leftKnown && rightKnown) gradTx = 0.5 * (dist[idx + 1] - dist[idx - 1]);
    else if (leftKnown) gradTx = dist[idx] - dist[idx - 1];
    else if (rightKnown) gradTx = dist[idx + 1] - dist[idx];

    const upKnown = y > 0 && state[idx - w] === FMM_KNOWN;
    const downKnown = y + 1 < h && state[idx + w] === FMM_KNOWN;
    if (upKnown && downKnown) gradTy = 0.5 * (dist[idx + w] - dist[idx - w]);
    else if (upKnown) gradTy = dist[idx] - dist[idx - w];
    else if (downKnown) gradTy = dist[idx + w] - dist[idx];

    const gradLen = Math.hypot(gradTx, gradTy);
    if (gradLen > 1e-6) {
      gradTx /= gradLen;
      gradTy /= gradLen;
    }

    for (let c = 0; c < channels; c++) {
      sumC[c] = 0;
      minC[c] = 255;
      maxC[c] = 0;
    }
    let sumW = 0;

    const yMin = Math.max(0, y - radius);
    const yMax = Math.min(h - 1, y + radius);
    const xMin = Math.max(0, x - radius);
    const xMax = Math.min(w - 1, x + radius);

    for (let ny = yMin; ny <= yMax; ny++) {
      const ry = y - ny;
      const nRow = ny * w;
      for (let nx = xMin; nx <= xMax; nx++) {
        const rx = x - nx;
        const d2 = rx * rx + ry * ry;
        if (d2 === 0 || d2 > radiusSq) continue;
        const nIdx = nRow + nx;
        if (state[nIdx] !== FMM_KNOWN) continue;

        const d = Math.sqrt(d2);
        const dirW = Math.max(1e-3, Math.abs(rx * gradTx + ry * gradTy) / d);
        const dstW = 1 / (d2 * d);
        const levW = 1 / (1 + Math.abs(dist[idx] - dist[nIdx]));
        const wt = dirW * dstW * levW;
        sumW += wt;

        const hasGradX =
          nx > 0 && nx + 1 < w && state[nIdx - 1] === FMM_KNOWN && state[nIdx + 1] === FMM_KNOWN;
        const hasGradY =
          ny > 0 && ny + 1 < h && state[nIdx - w] === FMM_KNOWN && state[nIdx + w] === FMM_KNOWN;

        const base = nIdx * channels;
        for (let c = 0; c < channels; c++) {
          const nv = values[base + c];
          if (nv < minC[c]) minC[c] = nv;
          if (nv > maxC[c]) maxC[c] = nv;

          let gx = 0;
          let gy = 0;
          if (hasGradX)
            gx = 0.5 * (values[(nIdx + 1) * channels + c] - values[(nIdx - 1) * channels + c]);
          if (hasGradY)
            gy = 0.5 * (values[(nIdx + w) * channels + c] - values[(nIdx - w) * channels + c]);

          // 保守阻尼的一阶外推，在保证斜线与平滑渐变延续的同时杜绝高频振铃
          sumC[c] += wt * (nv + 0.45 * (gx * rx + gy * ry));
        }
      }
    }

    if (sumW > 0) {
      const outBase = idx * channels;
      for (let c = 0; c < channels; c++) {
        // 严格钳位在已知局部极值内，彻底杜绝边缘外推彩条
        values[outBase + c] = clamp(sumC[c] / sumW, minC[c], maxC[c]);
      }
    }

    state[idx] = FMM_KNOWN;

    for (let d = 0; d < 4; d++) {
      const nx = x + dirOffsets[d][0];
      const ny = y + dirOffsets[d][1];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (state[nIdx] === FMM_KNOWN) continue;
      const nextDist = solveEikonal(nx, ny, w, h, state, dist);
      if (nextDist < dist[nIdx]) {
        dist[nIdx] = nextDist;
        state[nIdx] = FMM_BAND;
        heap.pushOrDecrease(nIdx, nextDist);
      }
    }
  }
}

/**
 * 阶段二：收敛型离散拉普拉斯调和融合（求解 ∇²I = 0）
 * 固定洞外边界像素，使背景明暗与色彩渐变自然穿过选区，彻底消除字形轮廓与马赛克感。
 */
function blendBoundaryLaplace(
  values: Float32Array,
  holeIndices: Uint32Array,
  w: number,
  h: number,
  channels: 1 | 3,
  isHigh: boolean,
  shouldAbort?: () => boolean,
): void {
  const count = holeIndices.length;
  if (count === 0) return;

  const maxPasses = isHigh ? 160 : 100;
  const budget = isHigh ? 3_600_000 : 2_000_000;
  const iterations = clamp(Math.floor(budget / count), 8, maxPasses);
  // 大选区启用温和超松弛加速收敛，小笔画选区用稳定 Gauss-Seidel (1.0) 避免振荡
  const omega = count > 2400 ? 1.32 : 1.0;

  for (let pass = 0; pass < iterations; pass++) {
    checkAbort(shouldAbort);
    let maxChange = 0;
    for (let k = 0; k < count; k++) {
      const p = holeIndices[k];
      const x = p % w;
      const y = (p - x) / w;
      const left = (x > 0 ? p - 1 : p) * channels;
      const right = (x + 1 < w ? p + 1 : p) * channels;
      const up = (y > 0 ? p - w : p) * channels;
      const down = (y + 1 < h ? p + w : p) * channels;
      const base = p * channels;

      for (let c = 0; c < channels; c++) {
        const avg =
          (values[left + c] + values[right + c] + values[up + c] + values[down + c]) * 0.25;
        const prev = values[base + c];
        const next = omega === 1.0 ? avg : clamp(prev + omega * (avg - prev), 0, 255);
        const diff = Math.abs(next - prev);
        if (diff > maxChange) maxChange = diff;
        values[base + c] = next;
      }
    }
    if (maxChange < 0.05) break;
  }
}

/** 邻近同色高频微纹理采样偏移表 */
const TEXTURE_OFFSETS_STD: ReadonlyArray<readonly [number, number]> = [
  [-7, -3],
  [7, 3],
  [-3, 7],
  [3, -7],
  [-12, 4],
  [12, -4],
  [-6, -13],
  [6, 13],
  [-18, -7],
  [18, 7],
];

const TEXTURE_OFFSETS_HIGH: ReadonlyArray<readonly [number, number]> = [
  ...TEXTURE_OFFSETS_STD,
  [-10, -10],
  [10, 10],
  [-15, 11],
  [15, -11],
  [-24, 5],
  [24, -5],
];

/** 在周围未遮罩干净背景中寻找颜色最接近的邻近像素作为高频微粒供体 */
function findTextureDonor(
  p: number,
  w: number,
  h: number,
  mask: Uint8Array,
  origRgb: Float32Array,
  baseRgb: Float32Array,
  offsets: ReadonlyArray<readonly [number, number]>,
): number {
  const x = p % w;
  const y = (p - x) / w;
  const b0 = baseRgb[p * 3];
  const b1 = baseRgb[p * 3 + 1];
  const b2 = baseRgb[p * 3 + 2];

  let best = -1;
  let bestCost = 54;

  for (let i = 0; i < offsets.length; i++) {
    const tx = x + offsets[i][0];
    const ty = y + offsets[i][1];
    if (tx < 1 || tx + 1 >= w || ty < 1 || ty + 1 >= h) continue;
    const q = ty * w + tx;
    if (mask[q] || mask[q - 1] || mask[q + 1] || mask[q - w] || mask[q + w]) continue;
    const qb = q * 3;
    const diff =
      Math.abs(origRgb[qb] - b0) + Math.abs(origRgb[qb + 1] - b1) + Math.abs(origRgb[qb + 2] - b2);
    if (diff < bestCost) {
      bestCost = diff;
      best = q;
    }
  }
  return best;
}

/** 提取像素点处的拉普拉斯高频微细节 */
function laplacianDetailAt(rgb: Float32Array, p: number, w: number, c: number): number {
  return (
    rgb[p * 3 + c] -
    0.25 *
      (rgb[(p - 1) * 3 + c] + rgb[(p + 1) * 3 + c] + rgb[(p - w) * 3 + c] + rgb[(p + w) * 3 + c])
  );
}

/** 为命中当前 ROI 的可逆半透明模板构建逐像素覆盖度图（0~255） */
function buildRoiTemplateAlpha(
  marks: readonly MatchedWatermark[] | undefined,
  roiX: number,
  roiY: number,
  roiW: number,
  roiH: number,
): Uint8Array | null {
  if (!marks || marks.length === 0) return null;

  let alpha: Uint8Array | null = null;

  for (const mark of marks) {
    const tpl = WATERMARK_TEMPLATES[mark.templateId];
    if (!tpl || !tpl.supportsAlphaRecovery) continue;

    const left = Math.max(roiX, mark.x);
    const top = Math.max(roiY, mark.y);
    const right = Math.min(roiX + roiW, mark.x + mark.width);
    const bottom = Math.min(roiY + roiH, mark.y + mark.height);
    if (left >= right || top >= bottom) continue;

    alpha ??= new Uint8Array(roiW * roiH);

    for (let y = top; y < bottom; y++) {
      const dstRow = (y - roiY) * roiW;
      for (let x = left; x < right; x++) {
        const a = Math.round(sampleMatchedMarkAlpha(mark, x - mark.x, y - mark.y));
        const idx = dstRow + (x - roiX);
        if (a > alpha[idx]) alpha[idx] = a;
      }
    }
  }

  return alpha;
}

/**
 * 温和保边内缘融合：仅在紧邻干净背景的 1px 内缘平滑锯齿，不污染非遮罩区
 */
function applyGentleBoundaryAntiAlias(
  outRgb: Float32Array,
  origRgba: Uint8ClampedArray,
  roiMask: Uint8Array,
  w: number,
  h: number,
  holeIndices: Uint32Array,
  featherPx: number,
): void {
  if (featherPx <= 0 || holeIndices.length === 0) return;

  const snap = new Float32Array(outRgb);
  const weight = clamp(featherPx / 10, 0.12, 0.35);

  for (let k = 0; k < holeIndices.length; k++) {
    const idx = holeIndices[k];
    const x = idx % w;
    const y = (idx - x) / w;
    const touchesOutside =
      (x > 0 && roiMask[idx - 1] === 0) ||
      (x + 1 < w && roiMask[idx + 1] === 0) ||
      (y > 0 && roiMask[idx - w] === 0) ||
      (y + 1 < h && roiMask[idx + w] === 0);
    if (!touchesOutside) continue;

    const cb = idx * 3;
    const cr = snap[cb];
    const cg = snap[cb + 1];
    const cbl = snap[cb + 2];

    let sr = cr;
    let sg = cg;
    let sb = cbl;
    let sw = 1;

    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        const nIdx = ny * w + nx;
        let nr: number;
        let ng: number;
        let nb: number;
        if (roiMask[nIdx] === 0) {
          const ob = nIdx * 4;
          nr = origRgba[ob];
          ng = origRgba[ob + 1];
          nb = origRgba[ob + 2];
        } else {
          const nb3 = nIdx * 3;
          nr = snap[nb3];
          ng = snap[nb3 + 1];
          nb = snap[nb3 + 2];
        }
        const diff2 = (nr - cr) * (nr - cr) + (ng - cg) * (ng - cg) + (nb - cbl) * (nb - cbl);
        const rangeW = Math.exp(-diff2 / 750);
        const spatialW = (dx === 0 || dy === 0 ? 0.55 : 0.32) * weight;
        const wt = rangeW * spatialW;
        sr += nr * wt;
        sg += ng * wt;
        sb += nb * wt;
        sw += wt;
      }
    }

    outRgb[cb] = sr / sw;
    outRgb[cb + 1] = sg / sw;
    outRgb[cb + 2] = sb / sw;
  }
}

/** 单个连通 ROI 簇的完整轻量修复执行器 */
async function inpaintSingleRoi(
  workData: Uint8ClampedArray<ArrayBuffer>,
  remainingMask: Uint8Array,
  origMask: Uint8Array,
  imgW: number,
  imgH: number,
  box: Box,
  quality: FastQuality,
  featherPx: number,
  matchedMarks: readonly MatchedWatermark[] | undefined,
  progressStart: number,
  progressSpan: number,
  asyncYieldMs: number,
  onProgress?: (stage: string, percent: number) => void,
  shouldAbort?: () => boolean,
): Promise<void> {
  checkAbort(shouldAbort);
  let lastYieldAt = performance.now();
  const maybeYield = async (): Promise<void> => {
    checkAbort(shouldAbort);
    if (asyncYieldMs > 0 && performance.now() - lastYieldAt >= asyncYieldMs) {
      await yieldToEventLoop();
      checkAbort(shouldAbort);
      lastYieldAt = performance.now();
    }
  };

  const roi = computeCompactRoi(box, imgW, imgH);
  const { x0: roiX, y0: roiY, w: roiW, h: roiH } = roi;
  const roiTotal = roiW * roiH;

  const origPremulRgb = new Float32Array(roiTotal * 3);
  const baseRgb = new Float32Array(roiTotal * 3);
  const alphaBuf = new Float32Array(roiTotal);
  const roiOrigRgba = new Uint8ClampedArray(roiTotal * 4);
  const roiMask = new Uint8Array(roiTotal);

  let holeCount = 0;
  let hasTransparency = false;

  for (let y = 0; y < roiH; y++) {
    const gRow = (roiY + y) * imgW + roiX;
    const rRow = y * roiW;
    for (let x = 0; x < roiW; x++) {
      const gIdx = gRow + x;
      const rIdx = rRow + x;
      const g4 = gIdx * 4;
      const r4 = rIdx * 4;
      const r3 = rIdx * 3;

      const r = workData[g4];
      const g = workData[g4 + 1];
      const b = workData[g4 + 2];
      const a = workData[g4 + 3];

      roiOrigRgba[r4] = r;
      roiOrigRgba[r4 + 1] = g;
      roiOrigRgba[r4 + 2] = b;
      roiOrigRgba[r4 + 3] = a;

      alphaBuf[rIdx] = a;
      if (a !== 255) hasTransparency = true;

      const scaleA = a / 255;
      const pr = r * scaleA;
      const pg = g * scaleA;
      const pb = b * scaleA;

      origPremulRgb[r3] = pr;
      origPremulRgb[r3 + 1] = pg;
      origPremulRgb[r3 + 2] = pb;
      baseRgb[r3] = pr;
      baseRgb[r3 + 1] = pg;
      baseRgb[r3 + 2] = pb;

      if (remainingMask[gIdx] > 0) {
        roiMask[rIdx] = 255;
        holeCount++;
      }
    }
  }

  if (holeCount === 0 || holeCount === roiTotal) return;

  const holeIndices = new Uint32Array(holeCount);
  for (let i = 0, ptr = 0; i < roiTotal; i++) {
    if (roiMask[i] > 0) holeIndices[ptr++] = i;
  }

  const isHigh = quality === 'high';

  // 阶段一：Telea FMM 填充
  onProgress?.('正在修补水印笔画骨架...', Math.round(progressStart + progressSpan * 0.2));
  runTeleaFmm(baseRgb, 3, roiMask, roiW, roiH, holeIndices, 3, shouldAbort);
  if (hasTransparency) {
    runTeleaFmm(alphaBuf, 1, roiMask, roiW, roiH, holeIndices, 3, shouldAbort);
  }
  await maybeYield();

  // 阶段二：收敛型拉普拉斯调和融合（消除拼接轮廓与马赛克）
  onProgress?.('正在拉普拉斯调和融合背景...', Math.round(progressStart + progressSpan * 0.58));
  blendBoundaryLaplace(baseRgb, holeIndices, roiW, roiH, 3, isHigh, shouldAbort);
  if (hasTransparency) {
    blendBoundaryLaplace(alphaBuf, holeIndices, roiW, roiH, 1, isHigh, shouldAbort);
  }
  await maybeYield();

  // 阶段三：半透明高频细节逆向补偿 + 邻近高频微纹理回填
  onProgress?.('正在还原背景细腻纹理...', Math.round(progressStart + progressSpan * 0.82));
  const tplAlpha = buildRoiTemplateAlpha(matchedMarks, roiX, roiY, roiW, roiH);
  const textureOffsets = isHigh ? TEXTURE_OFFSETS_HIGH : TEXTURE_OFFSETS_STD;
  const finalRgb = new Float32Array(roiTotal * 3);

  // 初始化非遮罩区原像素供温和抗锯齿读取
  for (let i = 0; i < roiTotal; i++) {
    const a = alphaBuf[i];
    const invA = a > 1 ? 255 / a : 0;
    const b3 = i * 3;
    finalRgb[b3] = clamp(baseRgb[b3] * invA, 0, 255);
    finalRgb[b3 + 1] = clamp(baseRgb[b3 + 1] * invA, 0, 255);
    finalRgb[b3 + 2] = clamp(baseRgb[b3 + 2] * invA, 0, 255);
  }

  const allowDonor = holeCount < (isHigh ? 140_000 : 90_000);

  for (let k = 0; k < holeCount; k++) {
    const p = holeIndices[k];
    const x = p % roiW;
    const y = (p - x) / roiW;
    const outA = Math.round(clamp(alphaBuf[p], 0, 255));
    const b3 = p * 3;
    const isInterior = x > 0 && x + 1 < roiW && y > 0 && y + 1 < roiH;

    const aNorm = tplAlpha ? tplAlpha[p] / 255 : 0;
    const stableAlpha =
      isInterior &&
      outA === 255 &&
      tplAlpha !== null &&
      aNorm >= 0.2 &&
      aNorm <= 0.85 &&
      Math.abs(tplAlpha[p - 1] - tplAlpha[p]) < 9 &&
      Math.abs(tplAlpha[p + 1] - tplAlpha[p]) < 9 &&
      Math.abs(tplAlpha[p - roiW] - tplAlpha[p]) < 9 &&
      Math.abs(tplAlpha[p + roiW] - tplAlpha[p]) < 9;

    const donor =
      !stableAlpha && outA === 255 && allowDonor
        ? findTextureDonor(p, roiW, roiH, roiMask, origPremulRgb, baseRgb, textureOffsets)
        : -1;

    for (let c = 0; c < 3; c++) {
      const local = outA > 0 ? clamp((baseRgb[b3 + c] * 255) / outA, 0, 255) : 0;

      if (stableAlpha) {
        // 半透明稳定笔画内部：按物理混合比例 1/(1-α) 取回底层真实高频纹理，低频锚定拉普拉斯调和底色杜绝字形残影
        const invOneMinusA = 1 / Math.max(0.15, 1 - aNorm);
        const hiDetail = laplacianDetailAt(origPremulRgb, p, roiW, c) * invOneMinusA;
        finalRgb[b3 + c] = clamp(local + 0.65 * clamp(hiDetail, -9, 9), 0, 255);
      } else if (donor >= 0) {
        const donorDetail = laplacianDetailAt(origPremulRgb, donor, roiW, c);
        finalRgb[b3 + c] = clamp(local + 0.65 * clamp(donorDetail, -9, 9), 0, 255);
      } else {
        finalRgb[b3 + c] = local;
      }
    }
  }

  // 轻微保边抗锯齿（仅在不透明区域应用，避免干扰半透明边界）
  if (!hasTransparency && featherPx > 0) {
    applyGentleBoundaryAntiAlias(
      finalRgb,
      roiOrigRgba,
      roiMask,
      roiW,
      roiH,
      holeIndices,
      featherPx,
    );
  }
  await maybeYield();

  // 仅写回遮罩覆盖像素；非遮罩区（origMask === 0）100% 保持原像素逐字节无损
  for (let y = 0; y < roiH; y++) {
    const gRow = (roiY + y) * imgW + roiX;
    const rRow = y * roiW;
    for (let x = 0; x < roiW; x++) {
      const gIdx = gRow + x;
      const mVal = origMask[gIdx];
      if (mVal === 0 || remainingMask[gIdx] === 0) continue;

      const rIdx = rRow + x;
      const r3 = rIdx * 3;
      const g4 = gIdx * 4;
      const outA = Math.round(clamp(alphaBuf[rIdx], 0, 255));

      if (mVal >= 255) {
        workData[g4] = Math.round(finalRgb[r3]);
        workData[g4 + 1] = Math.round(finalRgb[r3 + 1]);
        workData[g4 + 2] = Math.round(finalRgb[r3 + 2]);
        workData[g4 + 3] = outA;
      } else {
        const blend = mVal / 255;
        const invBlend = 1 - blend;
        workData[g4] = Math.round(workData[g4] * invBlend + finalRgb[r3] * blend);
        workData[g4 + 1] = Math.round(workData[g4 + 1] * invBlend + finalRgb[r3 + 1] * blend);
        workData[g4 + 2] = Math.round(workData[g4 + 2] * invBlend + finalRgb[r3 + 2] * blend);
        workData[g4 + 3] = Math.round(workData[g4 + 3] * invBlend + outA * blend);
      }

      remainingMask[gIdx] = 0;
    }
  }
}

/**
 * 异步分片执行纯前端零依赖轻量去水印核心流水线。
 * @param imageData 待修复图像像素数据（不会被原地修改）
 * @param mask 单通道遮罩数组（长度 = width * height，0 保留，>0 修复）
 * @param options 算法质量、羽化半径、模板命中信息、进度回调与中断检查
 * @param asyncYieldMs 分片让出时间间隔（毫秒），传入 0 表示不让出以追求极致吞吐
 */
export async function inpaintFastAsync(
  imageData: ImageData,
  mask: Uint8Array,
  options: FastInpaintCoreOptions = {},
  asyncYieldMs = 24,
): Promise<FastInpaintCoreResult> {
  const startTime = performance.now();
  const { width, height, data } = imageData;
  const expectedLen = width * height;

  if (mask.length !== expectedLen) {
    throw new Error(
      `遮罩尺寸与图像不匹配：期望 ${expectedLen} 像素（${width}×${height}），实际为 ${mask.length}。`,
    );
  }

  const quality: FastQuality = options.quality ?? 'standard';
  const featherPx = Math.max(0, options.featherPx ?? 3);
  const { matchedMarks, onProgress, shouldAbort } = options;

  checkAbort(shouldAbort);
  onProgress?.('提取修补区域...', 5);

  const outData = new Uint8ClampedArray(new ArrayBuffer(data.length));
  outData.set(data);

  const clusters = findMaskClusters(mask, width, height);
  if (clusters.length === 0) {
    onProgress?.('修补完成', 100);
    return {
      imageData: createImageDataSafe(outData, width, height),
      durationMs: Math.max(0, Math.round(performance.now() - startTime)),
    };
  }

  const totalHolePixels = clusters.reduce((acc, c) => acc + c.holePixels, 0);
  if (totalHolePixels >= expectedLen) {
    onProgress?.('修补完成', 100);
    return {
      imageData: createImageDataSafe(outData, width, height),
      durationMs: Math.max(0, Math.round(performance.now() - startTime)),
    };
  }

  const remainingMask = new Uint8Array(mask);
  let cursorPct = 8;
  const totalPctSpan = 90;

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const span = Math.max(5, (totalPctSpan * cluster.holePixels) / totalHolePixels);
    await inpaintSingleRoi(
      outData,
      remainingMask,
      mask,
      width,
      height,
      cluster,
      quality,
      featherPx,
      matchedMarks,
      cursorPct,
      span,
      asyncYieldMs,
      onProgress,
      shouldAbort,
    );
    cursorPct += span;
  }

  onProgress?.('修补完成', 100);
  return {
    imageData: createImageDataSafe(outData, width, height),
    durationMs: Math.max(0, Math.round(performance.now() - startTime)),
  };
}
