/**
 * LaMa ONNX 浏览器端推理核心（onnxruntime-web + 512×512 智能局部裁剪拼接）
 *
 * 关键设计：
 * 1. 自动检测 WebGPU 支持，优先使用 WebGPU 后端，初始化或运行失败时安全回退至 WASM；
 * 2. 依据 self.crossOriginIsolated 安全配置 ort.env.wasm.numThreads（非跨源隔离环境设为 1），杜绝 SharedArrayBuffer 异常；
 * 3. 动态读取 session.inputNames / session.outputNames / inputMetadata 适配常见 LaMa ONNX 变体，自动识别 [0,1] 与 [0,255] 双输出值域；
 * 4. 采用 Crop-and-Stitch 局部裁剪拼接 + 遮罩内缘平滑羽化，保证 4K 大图原分辨率输出且非遮罩区像素 100% 无损。
 */

import type * as OrtNamespace from 'onnxruntime-web/webgpu';
import type { InpaintInput, InpaintOutput, InpaintProgress, PixelRect } from '../../types';
import { findMaskClusters, inpaintFastAsync } from '../fast/inpaintCore';

/** 标准 LaMa ONNX 默认输入分辨率 */
export const DEFAULT_LAMA_INPUT_SIZE = 512;

/** 默认局部上下文扩张倍率（遮罩最大边的 2.2 倍） */
export const DEFAULT_CONTEXT_SCALE = 2.2;

/** 默认遮罩边缘平滑羽化半径（像素） */
export const DEFAULT_FEATHER_PX = 4;

/** LaMa 运行后端类型 */
export type LamaBackend = 'webgpu' | 'wasm';

/** 模型输出张量值域类型 */
export type LamaOutputValueRange = 'unit' | 'byte';

/** 动态解析出的模型输入/输出绑定信息 */
export interface ResolvedLamaSessionIO {
  imageInputName: string;
  maskInputName: string;
  outputName: string;
  inputSize: number;
}

/** 局部裁剪窗口几何计算结果 */
export interface CropWindowResult {
  cropRect: PixelRect;
  maskBounds: PixelRect;
}

/** 轻量输入元数据形状描述（便于单元测试与 ORT 实际元数据复用） */
export interface TensorMetaLike {
  readonly name: string;
  readonly isTensor: boolean;
  readonly shape?: readonly (number | string)[];
}

/** 活跃的 LaMa 推理会话封装 */
export interface ActiveLamaSession {
  ort: typeof OrtNamespace;
  session: OrtNamespace.InferenceSession;
  backend: LamaBackend;
  io: ResolvedLamaSessionIO;
}

interface NavigatorWithGpu extends Navigator {
  gpu?: {
    requestAdapter: () => Promise<unknown | null>;
  };
}

let cachedOrtModule: typeof OrtNamespace | null = null;
let ortEnvConfigured = false;

/**
 * 检测当前浏览器是否具备可用的 WebGPU 硬件加速环境
 */
export async function checkWebGpuSupport(): Promise<boolean> {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const nav = navigator as NavigatorWithGpu;
  if (!nav.gpu || typeof nav.gpu.requestAdapter !== 'function') {
    return false;
  }
  try {
    const adapter = await nav.gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

/** 按需加载 onnxruntime-web/webgpu（同时内置 WebGPU JSEP 与 WASM 回退后端，体积较全量包减少约 70%） */
async function loadAndConfigureOrt(): Promise<typeof OrtNamespace> {
  if (!cachedOrtModule) {
    cachedOrtModule = await import('onnxruntime-web/webgpu');
  }
  const ort = cachedOrtModule;

  if (!ortEnvConfigured) {
    const isIsolated =
      typeof globalThis !== 'undefined' &&
      'crossOriginIsolated' in globalThis &&
      Boolean(globalThis.crossOriginIsolated);

    if (isIsolated) {
      const cores =
        typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
          ? navigator.hardwareConcurrency
          : 2;
      ort.env.wasm.numThreads = Math.max(1, Math.min(4, Math.floor(cores / 2) || 1));
    } else {
      // 非跨源隔离页面（缺少 COOP/COEP 响应头）不可使用 SharedArrayBuffer，强制单线程避免报错
      ort.env.wasm.numThreads = 1;
    }

    // 在专用 Worker 中运行或主线程降级时均关闭 ORT 内部 proxy Worker（proxy 不兼容 WebGPU EP 且受 CSP 限制）
    ort.env.wasm.proxy = false;

    // 显式通过 Vite 资源 URL 解析与 onnxruntime-web/webgpu 内置 Asyncify 胶水配对的 WASM 文件，
    // 保证 dev/build 零 404、ABI 100% 匹配，且避免同时打包冗余的 jsep.wasm
    try {
      const wasmUrlModule =
        await import('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url');
      if (typeof wasmUrlModule.default === 'string' && wasmUrlModule.default.length > 0) {
        const resolvedUrl =
          typeof globalThis !== 'undefined' && 'location' in globalThis && globalThis.location?.href
            ? new URL(wasmUrlModule.default, globalThis.location.href).href
            : wasmUrlModule.default;
        ort.env.wasm.wasmPaths = { wasm: resolvedUrl };
      }
    } catch {
      // 非 Vite 环境回退至 onnxruntime-web 默认 WASM 解析路径
    }

    ortEnvConfigured = true;
  }

  return ort;
}

/**
 * 动态解析 LaMa ONNX 会话的输入/输出张量名称及期望的固定输入尺寸
 * 兼容标准 Carve/LaMa-ONNX (`image`, `mask` -> `output`) 及常见命名/分辨率变体。
 */
export function resolveSessionIO(
  inputNames: readonly string[],
  outputNames: readonly string[],
  inputMetadata?: readonly TensorMetaLike[],
): ResolvedLamaSessionIO {
  if (inputNames.length < 2) {
    throw new Error(
      `当前 ONNX 模型输入张量数量不足（仅 ${inputNames.length} 个），LaMa 模型至少需要 image 与 mask 两个输入。`,
    );
  }
  if (outputNames.length < 1) {
    throw new Error('当前 ONNX 模型未声明任何输出张量，无法执行图像修复。');
  }

  const metaByName = new Map<string, TensorMetaLike>();
  if (inputMetadata) {
    for (const meta of inputMetadata) {
      metaByName.set(meta.name, meta);
    }
  }

  // 优先按张量名称识别 mask / image，若命名不常规再依据通道数（C=1 / C=3）兜底
  let maskInputName = inputNames.find((name) => /mask/i.test(name));
  let imageInputName = inputNames.find(
    (name) => name !== maskInputName && /(image|img|input|rgb)/i.test(name),
  );

  if (!maskInputName) {
    maskInputName = inputNames.find((name) => {
      const meta = metaByName.get(name);
      return meta?.isTensor && meta.shape && meta.shape.length === 4 && meta.shape[1] === 1;
    });
  }

  if (!imageInputName) {
    imageInputName = inputNames.find((name) => {
      if (name === maskInputName) {
        return false;
      }
      const meta = metaByName.get(name);
      return meta?.isTensor && meta.shape && meta.shape.length === 4 && meta.shape[1] === 3;
    });
  }

  const resolvedImageName =
    imageInputName ?? inputNames.find((name) => name !== maskInputName) ?? inputNames[0];
  const resolvedMaskName =
    maskInputName ?? inputNames.find((name) => name !== resolvedImageName) ?? inputNames[1];

  const outputName =
    outputNames.find((name) => /(output|out|inpaint|image|img)/i.test(name)) ?? outputNames[0];

  // 从输入元数据检测静态正方形尺寸（如 512 或 800），动态维度时回退 512
  let inputSize = DEFAULT_LAMA_INPUT_SIZE;
  const imageMeta = metaByName.get(resolvedImageName);
  if (imageMeta?.isTensor && imageMeta.shape && imageMeta.shape.length === 4) {
    const h = imageMeta.shape[2];
    const w = imageMeta.shape[3];
    if (typeof h === 'number' && typeof w === 'number' && h >= 64 && h === w) {
      inputSize = h;
    }
  }

  return {
    imageInputName: resolvedImageName,
    maskInputName: resolvedMaskName,
    outputName,
    inputSize,
  };
}

/**
 * 从模型 ArrayBuffer 创建 ONNX Runtime Web 推理会话
 * 优先尝试 WebGPU，若不支持或编译失败则安全回退到 WASM，并记录实际执行后端。
 */
export async function createLamaSessionFromBuffer(
  buffer: ArrayBuffer,
  options?: { preferWebGpu?: boolean },
): Promise<ActiveLamaSession> {
  if (!buffer || buffer.byteLength === 0) {
    throw new Error('模型权重数据为空，请重新下载或导入 .onnx 模型。');
  }

  const ort = await loadAndConfigureOrt();
  const modelBytes = new Uint8Array(buffer);
  const preferWebGpu = options?.preferWebGpu ?? true;
  const webGpuSupported = preferWebGpu ? await checkWebGpuSupport() : false;

  let session: OrtNamespace.InferenceSession | null = null;
  let backend: LamaBackend = 'wasm';
  let webGpuError: unknown = null;

  if (webGpuSupported) {
    try {
      session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
      backend = 'webgpu';
    } catch (error) {
      // WebGPU 算子或显卡驱动不兼容时记录原因并安全回退至 WASM
      webGpuError = error;
    }
  }

  if (!session) {
    try {
      session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      backend = 'wasm';
    } catch (wasmError) {
      const wasmDetail = wasmError instanceof Error ? wasmError.message : String(wasmError);
      const gpuHint = webGpuError
        ? `（WebGPU 初始化失败：${webGpuError instanceof Error ? webGpuError.message : String(webGpuError)}）`
        : '';
      throw new Error(`初始化 LaMa ONNX 推理会话失败${gpuHint}：${wasmDetail}`);
    }
  }

  let io: ResolvedLamaSessionIO;
  try {
    io = resolveSessionIO(session.inputNames, session.outputNames, session.inputMetadata);
  } catch (error) {
    await session.release().catch(() => undefined);
    throw error;
  }

  return { ort, session, backend, io };
}

/**
 * 依据已求得的遮罩像素外接框直接计算局部裁剪窗口，避免重复分配/扫描整图掩码
 */
export function computeCropWindowFromBounds(
  imageWidth: number,
  imageHeight: number,
  maskBounds: PixelRect,
  modelInputSize: number = DEFAULT_LAMA_INPUT_SIZE,
  contextScale: number = DEFAULT_CONTEXT_SCALE,
): CropWindowResult | null {
  if (imageWidth <= 0 || imageHeight <= 0 || maskBounds.width <= 0 || maskBounds.height <= 0) {
    return null;
  }

  const minX = maskBounds.x;
  const minY = maskBounds.y;
  const maskWidth = maskBounds.width;
  const maskHeight = maskBounds.height;
  const maxX = minX + maskWidth - 1;
  const maxY = minY + maskHeight - 1;

  const maxMaskSide = Math.max(maskWidth, maskHeight);
  // 扣除微小浮点误差，避免如 400 * 2.2 = 880.0000000000001 被 ceil 误进位为 881
  const targetSide = Math.ceil(Math.max(modelInputSize, maxMaskSide * contextScale - 1e-6));
  const minImageSide = Math.min(imageWidth, imageHeight);

  let cropW: number;
  let cropH: number;

  if (targetSide <= minImageSide) {
    cropW = targetSide;
    cropH = targetSide;
  } else if (maskWidth <= minImageSide && maskHeight <= minImageSide) {
    // 期望窗口超出短边但短边仍能完整容纳遮罩时，保持正方形避免拉伸畸变
    cropW = minImageSide;
    cropH = minImageSide;
  } else {
    // 遮罩本身超过短边（例如横跨宽幅画面的长条水印）时，按轴扩张确保 100% 覆盖遮罩
    cropW = Math.min(imageWidth, Math.max(targetSide, maskWidth));
    cropH = Math.min(imageHeight, Math.max(targetSide, maskHeight));
  }

  const centerX = minX + maskWidth / 2;
  const centerY = minY + maskHeight / 2;

  let cropX = Math.round(centerX - cropW / 2);
  let cropY = Math.round(centerY - cropH / 2);

  // 边界钳位，同时保证 maskBounds 完整落入 cropRect 内部
  cropX = Math.max(0, Math.min(imageWidth - cropW, cropX));
  cropY = Math.max(0, Math.min(imageHeight - cropH, cropY));

  if (cropX > minX) {
    cropX = minX;
  }
  if (cropX + cropW < maxX + 1) {
    cropX = Math.max(0, maxX + 1 - cropW);
  }
  if (cropY > minY) {
    cropY = minY;
  }
  if (cropY + cropH < maxY + 1) {
    cropY = Math.max(0, maxY + 1 - cropH);
  }

  return {
    cropRect: { x: cropX, y: cropY, width: cropW, height: cropH },
    maskBounds,
  };
}

/**
 * 计算智能局部裁剪拼接（Crop-and-Stitch）上下文窗口
 *
 * 规则：
 * 1. 先计算遮罩外接矩形 maskBounds；无有效遮罩像素时返回 null；
 * 2. 期望正方形窗口边长 = max(modelInputSize, ceil(max(mw, mh) * 2.2))；
 * 3. 尽量保持 1:1 正方形避免缩放到 512×512 时产生比例畸变，同时保证 100% 完整包住整个遮罩且严格不越出图像边界。
 */
export function computeCropWindow(
  imageWidth: number,
  imageHeight: number,
  mask: Uint8Array,
  modelInputSize: number = DEFAULT_LAMA_INPUT_SIZE,
  contextScale: number = DEFAULT_CONTEXT_SCALE,
): CropWindowResult | null {
  if (imageWidth <= 0 || imageHeight <= 0 || mask.length < imageWidth * imageHeight) {
    return null;
  }

  let minX = imageWidth;
  let minY = imageHeight;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < imageHeight; y += 1) {
    const rowOffset = y * imageWidth;
    for (let x = 0; x < imageWidth; x += 1) {
      if (mask[rowOffset + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  const maskBounds: PixelRect = {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };

  return computeCropWindowFromBounds(
    imageWidth,
    imageHeight,
    maskBounds,
    modelInputSize,
    contextScale,
  );
}

/** 从整图 RGBA 像素中提取指定矩形区域 */
export function extractRgbaPatch(
  rgba: Uint8ClampedArray,
  imgW: number,
  rect: PixelRect,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(rect.width * rect.height * 4));
  const rowBytes = rect.width * 4;
  for (let y = 0; y < rect.height; y += 1) {
    const srcStart = ((rect.y + y) * imgW + rect.x) * 4;
    out.set(rgba.subarray(srcStart, srcStart + rowBytes), y * rowBytes);
  }
  return out;
}

/** 从整图单通道遮罩中提取指定矩形区域 */
export function extractMaskPatch(
  mask: Uint8Array,
  imgW: number,
  rect: PixelRect,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(rect.width * rect.height));
  for (let y = 0; y < rect.height; y += 1) {
    const srcStart = (rect.y + y) * imgW + rect.x;
    out.set(mask.subarray(srcStart, srcStart + rect.width), y * rect.width);
  }
  return out;
}

/**
 * 纯 TypeScript 双线性插值缩放 RGBA 图像块
 * 不依赖 DOM Canvas，浏览器、Worker 与 Vitest(jsdom) 环境表现完全一致。
 */
export function resizeRgbaBilinear(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8ClampedArray<ArrayBuffer> {
  if (srcW === dstW && srcH === dstH) {
    const copy = new Uint8ClampedArray(new ArrayBuffer(src.byteLength));
    copy.set(src);
    return copy;
  }

  const dst = new Uint8ClampedArray(new ArrayBuffer(dstW * dstH * 4));
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  // 预计算水平采样索引与权重，减少内层循环开销
  const x0Arr = new Int32Array(dstW);
  const x1Arr = new Int32Array(dstW);
  const wxArr = new Float32Array(dstW);
  for (let x = 0; x < dstW; x += 1) {
    const gx = (x + 0.5) * scaleX - 0.5;
    const clamped = Math.max(0, Math.min(srcW - 1, gx));
    const x0 = Math.floor(clamped);
    x0Arr[x] = x0;
    x1Arr[x] = Math.min(srcW - 1, x0 + 1);
    wxArr[x] = clamped - x0;
  }

  for (let y = 0; y < dstH; y += 1) {
    const gy = (y + 0.5) * scaleY - 0.5;
    const clampedY = Math.max(0, Math.min(srcH - 1, gy));
    const y0 = Math.floor(clampedY);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const wy = clampedY - y0;
    const invWy = 1 - wy;
    const row0 = y0 * srcW;
    const row1 = y1 * srcW;
    const dstRow = y * dstW;

    for (let x = 0; x < dstW; x += 1) {
      const x0 = x0Arr[x];
      const x1 = x1Arr[x];
      const wx = wxArr[x];
      const invWx = 1 - wx;

      const w00 = invWx * invWy;
      const w10 = wx * invWy;
      const w01 = invWx * wy;
      const w11 = wx * wy;

      const p00 = (row0 + x0) * 4;
      const p10 = (row0 + x1) * 4;
      const p01 = (row1 + x0) * 4;
      const p11 = (row1 + x1) * 4;
      const dp = (dstRow + x) * 4;

      dst[dp] = Math.round(src[p00] * w00 + src[p10] * w10 + src[p01] * w01 + src[p11] * w11);
      dst[dp + 1] = Math.round(
        src[p00 + 1] * w00 + src[p10 + 1] * w10 + src[p01 + 1] * w01 + src[p11 + 1] * w11,
      );
      dst[dp + 2] = Math.round(
        src[p00 + 2] * w00 + src[p10 + 2] * w10 + src[p01 + 2] * w01 + src[p11 + 2] * w11,
      );
      dst[dp + 3] = Math.round(
        src[p00 + 3] * w00 + src[p10 + 3] * w10 + src[p01 + 3] * w01 + src[p11 + 3] * w11,
      );
    }
  }

  return dst;
}

/**
 * 缩放二值遮罩到模型输入尺寸
 * - 下采样时采用保守最大池化（对应原图足迹内任意像素 > 0 即标记为 255），防止细小水印笔画在缩小后丢失；
 * - 上采样时采用双线性插值后二值化，边缘过渡均匀。
 */
export function resizeMaskForModel(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8Array<ArrayBuffer> {
  const dst = new Uint8Array(new ArrayBuffer(dstW * dstH));

  if (srcW === dstW && srcH === dstH) {
    for (let i = 0; i < src.length; i += 1) {
      dst[i] = src[i] > 0 ? 255 : 0;
    }
    return dst;
  }

  const isDownscaling = srcW > dstW || srcH > dstH;
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  if (isDownscaling) {
    for (let y = 0; y < dstH; y += 1) {
      const sy0 = Math.floor(y * scaleY);
      const sy1 = Math.min(srcH, Math.max(sy0 + 1, Math.ceil((y + 1) * scaleY)));
      const dstRow = y * dstW;
      for (let x = 0; x < dstW; x += 1) {
        const sx0 = Math.floor(x * scaleX);
        const sx1 = Math.min(srcW, Math.max(sx0 + 1, Math.ceil((x + 1) * scaleX)));
        let hit = false;
        for (let sy = sy0; sy < sy1 && !hit; sy += 1) {
          const srcRow = sy * srcW;
          for (let sx = sx0; sx < sx1; sx += 1) {
            if (src[srcRow + sx] > 0) {
              hit = true;
              break;
            }
          }
        }
        if (hit) {
          dst[dstRow + x] = 255;
        }
      }
    }
    return dst;
  }

  for (let y = 0; y < dstH; y += 1) {
    const gy = Math.max(0, Math.min(srcH - 1, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const wy = gy - y0;
    const invWy = 1 - wy;
    const row0 = y0 * srcW;
    const row1 = y1 * srcW;
    const dstRow = y * dstW;

    for (let x = 0; x < dstW; x += 1) {
      const gx = Math.max(0, Math.min(srcW - 1, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const wx = gx - x0;
      const invWx = 1 - wx;

      const v00 = src[row0 + x0] > 0 ? 1 : 0;
      const v10 = src[row0 + x1] > 0 ? 1 : 0;
      const v01 = src[row1 + x0] > 0 ? 1 : 0;
      const v11 = src[row1 + x1] > 0 ? 1 : 0;

      const interpolated =
        v00 * invWx * invWy + v10 * wx * invWy + v01 * invWx * wy + v11 * wx * wy;
      dst[dstRow + x] = interpolated >= 0.5 ? 255 : 0;
    }
  }

  return dst;
}

/**
 * 将模型输入尺寸的 RGBA 与二值遮罩打包为 NCHW Float32 张量
 * - image: [1, 3, S, S]，RGB 归一化至 [0, 1]
 * - mask:  [1, 1, S, S]，二值化为 1.0（待修复）/ 0.0（保留）
 */
export function packLamaInputs(
  rgba: Uint8ClampedArray,
  mask: Uint8Array,
  size: number = DEFAULT_LAMA_INPUT_SIZE,
): {
  imageData: Float32Array;
  maskData: Float32Array;
  imageDims: [1, 3, number, number];
  maskDims: [1, 1, number, number];
} {
  const pixelCount = size * size;
  if (rgba.length < pixelCount * 4) {
    throw new Error(`输入图像缓冲区长度不足（预期 ${pixelCount * 4}，实际 ${rgba.length}）。`);
  }
  if (mask.length < pixelCount) {
    throw new Error(`输入遮罩缓冲区长度不足（预期 ${pixelCount}，实际 ${mask.length}）。`);
  }

  const imageData = new Float32Array(3 * pixelCount);
  const maskData = new Float32Array(pixelCount);
  const gOffset = pixelCount;
  const bOffset = pixelCount * 2;
  const inv255 = 1 / 255;

  for (let i = 0; i < pixelCount; i += 1) {
    const p = i * 4;
    imageData[i] = rgba[p] * inv255;
    imageData[gOffset + i] = rgba[p + 1] * inv255;
    imageData[bOffset + i] = rgba[p + 2] * inv255;
    maskData[i] = mask[i] > 0 ? 1.0 : 0.0;
  }

  return {
    imageData,
    maskData,
    imageDims: [1, 3, size, size],
    maskDims: [1, 1, size, size],
  };
}

/**
 * 自动探测 LaMa 输出张量数值范围（[0, 1] 还是 [0, 255]）
 * 允许浮点模型产生轻微过冲（例如 1.05 仍按 [0, 1] 处理）。
 */
export function detectOutputValueRange(data: Float32Array): LamaOutputValueRange {
  let maxVal = -Infinity;
  let minVal = Infinity;

  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    if (!Number.isFinite(v)) {
      continue;
    }
    if (v > maxVal) maxVal = v;
    if (v < minVal) minVal = v;
  }

  if (maxVal === -Infinity) {
    return 'byte';
  }
  return maxVal <= 1.5 && minVal >= -0.5 ? 'unit' : 'byte';
}

/**
 * 将 LaMa 输出张量自适应解包为 RGBA Uint8ClampedArray
 * 支持标准 NCHW [1, 3, H, W] 与少数变体的 NHWC [1, H, W, 3]。
 */
export function unpackLamaOutput(
  data: Float32Array,
  width: number,
  height: number,
  dims?: readonly number[],
): { rgba: Uint8ClampedArray<ArrayBuffer>; detectedRange: LamaOutputValueRange } {
  const pixelCount = width * height;
  if (data.length < pixelCount * 3) {
    throw new Error(
      `模型输出张量元素数量不足（预期至少 ${pixelCount * 3}，实际 ${data.length}）。`,
    );
  }

  const detectedRange = detectOutputValueRange(data);
  const scale = detectedRange === 'unit' ? 255 : 1;
  const rgba = new Uint8ClampedArray(new ArrayBuffer(pixelCount * 4));
  const isNhwc = Boolean(dims && dims.length === 4 && dims[3] === 3 && dims[1] !== 3);

  const clampByte = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    const scaled = value * scale;
    if (scaled <= 0) return 0;
    if (scaled >= 255) return 255;
    return Math.round(scaled);
  };

  if (isNhwc) {
    for (let i = 0; i < pixelCount; i += 1) {
      const s = i * 3;
      const d = i * 4;
      rgba[d] = clampByte(data[s]);
      rgba[d + 1] = clampByte(data[s + 1]);
      rgba[d + 2] = clampByte(data[s + 2]);
      rgba[d + 3] = 255;
    }
  } else {
    const gOffset = pixelCount;
    const bOffset = pixelCount * 2;
    for (let i = 0; i < pixelCount; i += 1) {
      const d = i * 4;
      rgba[d] = clampByte(data[i]);
      rgba[d + 1] = clampByte(data[gOffset + i]);
      rgba[d + 2] = clampByte(data[bOffset + i]);
      rgba[d + 3] = 255;
    }
  }

  return { rgba, detectedRange };
}

/**
 * 计算遮罩内缘平滑羽化权重图（0~1）
 *
 * 严格约束：
 * - 非遮罩像素（mask === 0）权重恒为 0，确保原图非遮罩区域 100% 字节级无损；
 * - 遮罩内部使用两遍 Chamfer 距离变换计算到最近未遮罩像素的距离，仅对与非遮罩相邻的内边界平滑羽化；
 * - 紧贴画布四边的遮罩像素不会被误判为未遮罩边界，避免角落水印在画布最外缘残留。
 */
export function computeInnerFeatherAlpha(
  maskPatch: Uint8Array,
  width: number,
  height: number,
  featherPx: number = DEFAULT_FEATHER_PX,
): Float32Array {
  const total = width * height;
  const alpha = new Float32Array(total);
  const effectiveFeather = Math.max(0, featherPx);

  if (effectiveFeather === 0) {
    for (let i = 0; i < total; i += 1) {
      alpha[i] = maskPatch[i] > 0 ? 1.0 : 0.0;
    }
    return alpha;
  }

  const INF = 1e6;
  const dist = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    dist[i] = maskPatch[i] > 0 ? INF : 0;
  }

  const DIAG = Math.SQRT2;

  // 第一遍：自左上向右下扫描
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const prevRow = row - width;
    for (let x = 0; x < width; x += 1) {
      const idx = row + x;
      let d = dist[idx];
      if (d === 0) continue;
      if (x > 0) {
        const cand = dist[idx - 1] + 1;
        if (cand < d) d = cand;
      }
      if (y > 0) {
        const up = dist[prevRow + x] + 1;
        if (up < d) d = up;
        if (x > 0) {
          const upLeft = dist[prevRow + x - 1] + DIAG;
          if (upLeft < d) d = upLeft;
        }
        if (x + 1 < width) {
          const upRight = dist[prevRow + x + 1] + DIAG;
          if (upRight < d) d = upRight;
        }
      }
      dist[idx] = d;
    }
  }

  // 第二遍：自右下向左上回扫
  for (let y = height - 1; y >= 0; y -= 1) {
    const row = y * width;
    const nextRow = row + width;
    for (let x = width - 1; x >= 0; x -= 1) {
      const idx = row + x;
      let d = dist[idx];
      if (d === 0) continue;
      if (x + 1 < width) {
        const cand = dist[idx + 1] + 1;
        if (cand < d) d = cand;
      }
      if (y + 1 < height) {
        const down = dist[nextRow + x] + 1;
        if (down < d) d = down;
        if (x + 1 < width) {
          const downRight = dist[nextRow + x + 1] + DIAG;
          if (downRight < d) d = downRight;
        }
        if (x > 0) {
          const downLeft = dist[nextRow + x - 1] + DIAG;
          if (downLeft < d) d = downLeft;
        }
      }
      dist[idx] = d;
    }
  }

  const denom = effectiveFeather + 0.5;
  for (let i = 0; i < total; i += 1) {
    if (maskPatch[i] === 0) {
      alpha[i] = 0;
      continue;
    }
    const d = dist[i];
    if (d >= denom) {
      alpha[i] = 1;
    } else {
      const t = Math.max(0, Math.min(1, d / denom));
      // 三次 Smoothstep 曲线，过渡自然无明显阶跃感
      alpha[i] = t * t * (3 - 2 * t);
    }
  }

  return alpha;
}

/** 羽化回贴扩展参数 */
export interface StitchFeatheredPatchOptions {
  /** 内缘羽化融合底色及透明通道来源（传入轻量预填图可杜绝将原始水印像素混回修复区） */
  featherBaseRgba?: Uint8ClampedArray;
  /** 限定本次仅回贴该簇外接框内的遮罩像素，避免交叠裁剪窗口跨簇覆盖 */
  clusterRect?: PixelRect;
  /** 跨簇已回贴标记位，防止重叠区域重复覆写 */
  writtenMask?: Uint8Array;
}

/**
 * 将还原至裁剪尺寸的修复块以边缘羽化方式回贴到原图
 * 非遮罩像素（mask === 0）完全跳过写入，保证 100% 原像素无损。
 */
export function stitchFeatheredPatch(
  originalRgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  mask: Uint8Array,
  patchRgba: Uint8ClampedArray,
  cropRect: PixelRect,
  featherPx: number = DEFAULT_FEATHER_PX,
  options?: StitchFeatheredPatchOptions,
): Uint8ClampedArray<ArrayBuffer> {
  const output = new Uint8ClampedArray(new ArrayBuffer(imgW * imgH * 4));
  output.set(originalRgba);

  const maskPatch = extractMaskPatch(mask, imgW, cropRect);
  const alphaMap = computeInnerFeatherAlpha(maskPatch, cropRect.width, cropRect.height, featherPx);
  const featherBase = options?.featherBaseRgba ?? originalRgba;
  const usePrefilledAlpha = Boolean(options?.featherBaseRgba);
  const clusterRect = options?.clusterRect;
  const writtenMask = options?.writtenMask;

  const cX0 = clusterRect ? clusterRect.x : cropRect.x;
  const cY0 = clusterRect ? clusterRect.y : cropRect.y;
  const cX1 = clusterRect ? clusterRect.x + clusterRect.width : cropRect.x + cropRect.width;
  const cY1 = clusterRect ? clusterRect.y + clusterRect.height : cropRect.y + cropRect.height;

  for (let py = 0; py < cropRect.height; py += 1) {
    const gy = cropRect.y + py;
    if (gy < cY0 || gy >= cY1) continue;
    const imgRow = gy * imgW + cropRect.x;
    const patchRow = py * cropRect.width;

    for (let px = 0; px < cropRect.width; px += 1) {
      const gx = cropRect.x + px;
      if (gx < cX0 || gx >= cX1) continue;
      const imgIdx = imgRow + px;
      const mVal = mask[imgIdx];
      if (mVal === 0 || writtenMask?.[imgIdx]) {
        continue;
      }

      const patchIdx = patchRow + px;
      const a = alphaMap[patchIdx] * (mVal / 255);
      if (a <= 0) {
        continue;
      }

      const dp = imgIdx * 4;
      const sp = patchIdx * 4;

      if (a >= 0.999) {
        output[dp] = patchRgba[sp];
        output[dp + 1] = patchRgba[sp + 1];
        output[dp + 2] = patchRgba[sp + 2];
      } else {
        // 传入 prefilledRgba 作为内缘羽化底色时，与干净预填平滑衔接，杜绝原水印亮色混回产生残影
        const invA = 1 - a;
        output[dp] = Math.round(featherBase[dp] * invA + patchRgba[sp] * a);
        output[dp + 1] = Math.round(featherBase[dp + 1] * invA + patchRgba[sp + 1] * a);
        output[dp + 2] = Math.round(featherBase[dp + 2] * invA + patchRgba[sp + 2] * a);
      }

      // 传入轻量预填图时同步其修补后的 Alpha 通道，兼顾透明 PNG / WebP 去水印
      if (usePrefilledAlpha && mVal >= 255) {
        output[dp + 3] = featherBase[dp + 3];
      }

      if (writtenMask) {
        writtenMask[imgIdx] = 1;
      }
    }
  }

  return output;
}

/** 安全构造 ImageData（兼容浏览器与 jsdom 测试环境） */
export function createImageDataCompat(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): ImageData {
  if (typeof ImageData === 'function') {
    return new ImageData(rgba, width, height);
  }
  return {
    data: rgba,
    width,
    height,
    colorSpace: 'srgb',
  } as ImageData;
}

/** 构造统一的中止异常 */
function createAbortError(): Error {
  if (typeof DOMException === 'function') {
    return new DOMException('已取消 AI 去水印任务。', 'AbortError');
  }
  const error = new Error('已取消 AI 去水印任务。');
  error.name = 'AbortError';
  return error;
}

/**
 * 使用已初始化的 LaMa 会话执行分簇局部裁剪推理与羽化拼接：
 * - 先用轻量引擎预填遮罩区，减少亮色水印边缘渗色；
 * - 按连通选区分簇各自独立截取正方形上下文窗口，避免双角水印被合成整图压扁分辨率。
 */
export async function executeLamaInpaint(
  activeSession: ActiveLamaSession,
  input: InpaintInput,
  options?: {
    onProgress?: (progress: InpaintProgress) => void;
    signal?: AbortSignal;
  },
): Promise<InpaintOutput> {
  const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { imageData, mask } = input;
  const { width, height, data } = imageData;
  const featherPx = input.featherPx ?? DEFAULT_FEATHER_PX;
  const { onProgress, signal } = options ?? {};

  if (mask.length !== width * height) {
    throw new Error(
      `遮罩尺寸与图像不匹配（图像 ${width}×${height} 需 ${width * height} 字节，实际遮罩 ${mask.length} 字节）。`,
    );
  }

  if (signal?.aborted) {
    throw createAbortError();
  }

  const { ort, session, backend, io } = activeSession;
  const clusters = findMaskClusters(mask, width, height);

  // 空遮罩时直接返回原图副本，不做多余推理
  if (clusters.length === 0) {
    const copy = new Uint8ClampedArray(new ArrayBuffer(data.byteLength));
    copy.set(data);
    onProgress?.({ stage: '选区为空，已保留原图', percent: 100 });
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
      imageData: createImageDataCompat(copy, width, height),
      durationMs: Math.max(0, Math.round(now - startTime)),
      backend,
    };
  }

  // 轻量预填遮罩像素，消除原始高亮水印边缘渗入 512 缩放特征
  onProgress?.({ stage: '正在预平滑选区边缘并规划局部窗口...', percent: 10 });
  const prefilled = await inpaintFastAsync(
    imageData,
    mask,
    {
      quality: 'standard',
      featherPx: 0,
      matchedMarks: input.matchedMarks,
      shouldAbort: () => Boolean(signal?.aborted),
    },
    24,
  );
  const prefilledRgba = prefilled.imageData.data;

  // 直接依据各簇像素外接框计算并归并裁剪窗，避免为每个簇重复分配整图遮罩
  const cropPlans: Array<{ cropRect: PixelRect; clusterRect: PixelRect }> = [];
  const planByKey = new Map<string, { cropRect: PixelRect; clusterRect: PixelRect }>();
  for (const box of clusters) {
    const clusterRect: PixelRect = {
      x: box.minX,
      y: box.minY,
      width: box.maxX - box.minX + 1,
      height: box.maxY - box.minY + 1,
    };
    const win = computeCropWindowFromBounds(
      width,
      height,
      clusterRect,
      io.inputSize,
      DEFAULT_CONTEXT_SCALE,
    );
    if (!win) continue;
    const key = `${win.cropRect.x},${win.cropRect.y},${win.cropRect.width},${win.cropRect.height}`;
    const existing = planByKey.get(key);
    if (existing) {
      const minX = Math.min(existing.clusterRect.x, clusterRect.x);
      const minY = Math.min(existing.clusterRect.y, clusterRect.y);
      const maxX = Math.max(
        existing.clusterRect.x + existing.clusterRect.width,
        clusterRect.x + clusterRect.width,
      );
      const maxY = Math.max(
        existing.clusterRect.y + existing.clusterRect.height,
        clusterRect.y + clusterRect.height,
      );
      existing.clusterRect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    } else {
      const entry = { cropRect: win.cropRect, clusterRect };
      planByKey.set(key, entry);
      cropPlans.push(entry);
    }
  }

  let currentOutput = new Uint8ClampedArray(new ArrayBuffer(data.byteLength));
  currentOutput.set(data);
  const writtenMask = new Uint8Array(width * height);

  const clusterSpan = 82 / Math.max(1, cropPlans.length);

  for (let i = 0; i < cropPlans.length; i += 1) {
    if (signal?.aborted) {
      throw createAbortError();
    }

    const { cropRect, clusterRect } = cropPlans[i];
    const basePct = 15 + i * clusterSpan;
    const prefix = cropPlans.length > 1 ? `[区域 ${i + 1}/${cropPlans.length}] ` : '';

    const cropRgba = extractRgbaPatch(prefilledRgba, width, cropRect);
    const cropMask = extractMaskPatch(mask, width, cropRect);

    onProgress?.({
      stage: `${prefix}正在将局部区域缩放至 ${io.inputSize}×${io.inputSize} 并打包张量...`,
      percent: Math.round(basePct + clusterSpan * 0.2),
    });

    const resizedRgba = resizeRgbaBilinear(
      cropRgba,
      cropRect.width,
      cropRect.height,
      io.inputSize,
      io.inputSize,
    );
    const resizedMask = resizeMaskForModel(
      cropMask,
      cropRect.width,
      cropRect.height,
      io.inputSize,
      io.inputSize,
    );

    const packed = packLamaInputs(resizedRgba, resizedMask, io.inputSize);
    const imageTensor = new ort.Tensor('float32', packed.imageData, packed.imageDims);
    const maskTensor = new ort.Tensor('float32', packed.maskData, packed.maskDims);

    if (signal?.aborted) {
      imageTensor.dispose();
      maskTensor.dispose();
      throw createAbortError();
    }

    onProgress?.({
      stage:
        backend === 'webgpu'
          ? `${prefix}正在使用 WebGPU 执行 LaMa 神经网络修复...`
          : `${prefix}正在使用 WASM 执行 LaMa 神经网络修复...`,
      percent: Math.round(basePct + clusterSpan * 0.5),
    });

    const feeds: OrtNamespace.InferenceSession.FeedsType = {
      [io.imageInputName]: imageTensor,
      [io.maskInputName]: maskTensor,
    };

    let results: OrtNamespace.InferenceSession.ReturnType;
    try {
      results = await session.run(feeds);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`LaMa 神经网络推理执行失败（${backend.toUpperCase()}）：${detail}`);
    } finally {
      imageTensor.dispose();
      maskTensor.dispose();
    }

    if (signal?.aborted) {
      for (const value of Object.values(results)) {
        if (value && typeof (value as OrtNamespace.Tensor).dispose === 'function') {
          (value as OrtNamespace.Tensor).dispose();
        }
      }
      throw createAbortError();
    }

    onProgress?.({
      stage: `${prefix}正在还原高清分辨率并执行边缘羽化融合...`,
      percent: Math.round(basePct + clusterSpan * 0.85),
    });

    const outputValue = results[io.outputName] ?? Object.values(results)[0];
    if (!outputValue) {
      throw new Error('LaMa 推理未返回有效输出张量。');
    }

    let outputFloatData: Float32Array;
    const outputDims = (outputValue as OrtNamespace.Tensor).dims;
    try {
      const tensor = outputValue as OrtNamespace.Tensor;
      const rawData = typeof tensor.getData === 'function' ? await tensor.getData() : tensor.data;
      if (rawData instanceof Float32Array) {
        outputFloatData = rawData;
      } else if (ArrayBuffer.isView(rawData)) {
        outputFloatData = Float32Array.from(rawData as unknown as ArrayLike<number>);
      } else {
        throw new Error('模型输出张量数据类型不是浮点数组。');
      }
    } finally {
      for (const value of Object.values(results)) {
        if (value && typeof (value as OrtNamespace.Tensor).dispose === 'function') {
          (value as OrtNamespace.Tensor).dispose();
        }
      }
    }

    const { rgba: restoredModelRgba } = unpackLamaOutput(
      outputFloatData,
      io.inputSize,
      io.inputSize,
      outputDims,
    );

    const restoredCropRgba = resizeRgbaBilinear(
      restoredModelRgba,
      io.inputSize,
      io.inputSize,
      cropRect.width,
      cropRect.height,
    );

    currentOutput = stitchFeatheredPatch(
      currentOutput,
      width,
      height,
      mask,
      restoredCropRgba,
      cropRect,
      featherPx,
      {
        featherBaseRgba: prefilledRgba,
        clusterRect: cropPlans.length > 1 ? clusterRect : undefined,
        writtenMask,
      },
    );
  }

  onProgress?.({ stage: 'AI 高清修复完成', percent: 100 });

  const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    imageData: createImageDataCompat(currentOutput, width, height),
    durationMs: Math.max(0, Math.round(endTime - startTime)),
    backend,
  };
}
