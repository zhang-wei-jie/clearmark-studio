/**
 * LaMa ONNX 模型源管理、流式下载校验与本地文件导入
 *
 * 所有内置下载地址均已核实为公开可访问的 Big-LaMa 512×512 ONNX 仓库：
 * - Carve/LaMa-ONNX (`lama_fp32.onnx`, ~208 MB, Opset 17, 自定义 FourierUnitJIT)
 * - imagingforgood/lama-512-onnx (`lama_512.onnx`, ~208 MB, WebGPU 友好转换版)
 */

import type { LamaModelSource } from '../../types';
import { saveModelToCache, type CachedModelMeta } from './modelCache';

/** 内置公开 LaMa ONNX 模型源列表（默认推荐国内镜像源） */
export const DEFAULT_LAMA_SOURCES: LamaModelSource[] = [
  {
    id: 'hf-mirror-carve',
    label: '国内镜像源（推荐 · HF-Mirror）',
    url: 'https://hf-mirror.com/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',
    description: 'Carve/LaMa-ONNX 官方权重国内镜像（512×512，Opset 17），国内直连更稳定',
    sizeHintMB: 208,
  },
  {
    id: 'huggingface-carve',
    label: 'HuggingFace 官方源（Carve/LaMa-ONNX）',
    url: 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',
    description: 'HuggingFace 官方直链（lama_fp32.onnx，兼容浏览器 WebGPU 与 WASM）',
    sizeHintMB: 208,
  },
  {
    id: 'hf-mirror-imagingforgood',
    label: '备用国内镜像（imagingforgood/lama-512）',
    url: 'https://hf-mirror.com/imagingforgood/lama-512-onnx/resolve/main/lama_512.onnx',
    description: '面向浏览器 WebGPU 整理的 Big-LaMa 512×512 权重，主源异常时可切换',
    sizeHintMB: 208,
  },
  {
    id: 'huggingface-imagingforgood',
    label: '备用官方源（imagingforgood/lama-512）',
    url: 'https://huggingface.co/imagingforgood/lama-512-onnx/resolve/main/lama_512.onnx',
    description: 'HuggingFace 备用 Big-LaMa 512×512 模型直链（lama_512.onnx）',
    sizeHintMB: 208,
  },
];

/** 真实 LaMa ONNX 权重最小体积阈值（1 MB），用于过滤错误页与残缺文件 */
export const MIN_VALID_LAMA_BYTES = 1024 * 1024;

/** 模型下载错误分类 */
export type LamaModelErrorCode =
  'ABORTED' | 'INVALID_URL' | 'HTTP_ERROR' | 'NETWORK_OR_CORS' | 'INVALID_MODEL' | 'STORAGE_ERROR';

/** 结构化模型管理异常 */
export class LamaModelError extends Error {
  readonly code: LamaModelErrorCode;
  readonly httpStatus?: number;

  constructor(code: LamaModelErrorCode, message: string, httpStatus?: number) {
    super(message);
    // 取消错误保留标准 AbortError 名称，便于上层统一通过 error.name === 'AbortError' 识别
    this.name = code === 'ABORTED' ? 'AbortError' : 'LamaModelError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 模型流式下载进度信息 */
export interface ModelDownloadProgress {
  loadedBytes: number;
  totalBytes?: number;
  percent?: number;
}

/** 模型下载可选参数 */
export interface DownloadModelOptions {
  onProgress?: (progress: ModelDownloadProgress) => void;
  signal?: AbortSignal;
  /** 允许测试覆盖最小体积阈值，默认 MIN_VALID_LAMA_BYTES (1 MB) */
  minBytes?: number;
}

/** ONNX 模型二进制校验结果 */
export type ModelValidationResult = { valid: true } | { valid: false; reason: string };

/** 常见非 ONNX 文件的文本/网页前缀特征 */
const TEXT_ERROR_PREFIXES = [
  '<!doctype',
  '<html',
  '<head',
  '<body',
  '<?xml',
  '<svg',
  '{"error',
  '{"detail',
  '{"message',
  'error:',
  'not found',
];

/** onnx.ModelProto 顶层合法 Protobuf 字段编号及其对应的 wire type */
const ONNX_MODEL_PROTO_FIELD_WIRE_TYPES: Readonly<Record<number, number>> = {
  1: 0, // ir_version (int64)
  2: 2, // producer_name (string)
  3: 2, // producer_version (string)
  4: 2, // domain (string)
  5: 0, // model_version (int64)
  6: 2, // doc_string (string)
  7: 2, // graph (GraphProto)
  8: 2, // opset_import (OperatorSetIdProto)
  14: 2, // metadata_props (StringStringEntryProto)
  20: 2, // training_info (TrainingInfoProto)
  25: 2, // functions (FunctionProto)
};

/** 检测缓冲区开头是否为 HTML/XML/JSON 等文本错误响应 */
function looksLikeTextOrHtml(bytes: Uint8Array): boolean {
  const sampleLen = Math.min(bytes.byteLength, 256);
  let text = '';
  for (let i = 0; i < sampleLen; i += 1) {
    text += String.fromCharCode(bytes[i]);
  }
  const normalized = text.trimStart().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith('{') || normalized.startsWith('[')) {
    return true;
  }
  return TEXT_ERROR_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** 检测缓冲区是否为明显错误的常见二进制格式（图片/压缩包/PDF） */
function detectNonOnnxBinaryFormat(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 4) {
    return null;
  }
  const [b0, b1, b2, b3] = bytes;
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) {
    return 'PNG 图片';
  }
  if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) {
    return 'JPEG 图片';
  }
  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) {
    return 'GIF 图片';
  }
  if (b0 === 0x50 && b1 === 0x4b && (b2 === 0x03 || b2 === 0x05 || b2 === 0x07)) {
    return 'ZIP 压缩包';
  }
  if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) {
    return 'PDF 文档';
  }
  if (b0 === 0x1f && b1 === 0x8b) {
    return 'GZIP 压缩文件';
  }
  return null;
}

/** 从 Uint8Array 指定偏移读取 Protobuf 无符号 varint */
function readProtobufVarint(
  bytes: Uint8Array,
  offset: number,
): { value: number; nextOffset: number } | null {
  let result = 0;
  let multiplier = 1;
  let pos = offset;
  const maxBytes = Math.min(bytes.byteLength, offset + 10);

  while (pos < maxBytes) {
    const byte = bytes[pos];
    result += (byte & 0x7f) * multiplier;
    pos += 1;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: pos };
    }
    multiplier *= 128;
  }
  return null;
}

/** 校验起始字节是否符合 ONNX ModelProto 的 Protobuf 编码结构 */
function hasValidOnnxProtobufHeader(bytes: Uint8Array): boolean {
  const firstTag = readProtobufVarint(bytes, 0);
  if (!firstTag) {
    return false;
  }
  const fieldNumber = Math.floor(firstTag.value / 8);
  const wireType = firstTag.value & 0x07;
  const expectedWireType = ONNX_MODEL_PROTO_FIELD_WIRE_TYPES[fieldNumber];

  if (expectedWireType === undefined || wireType !== expectedWireType) {
    return false;
  }

  if (wireType === 0) {
    const val = readProtobufVarint(bytes, firstTag.nextOffset);
    if (!val) {
      return false;
    }
    // field 1 为 ir_version，当前 ONNX 标准范围为 1~50
    if (fieldNumber === 1 && (val.value < 1 || val.value > 50)) {
      return false;
    }
    return true;
  }

  // wireType === 2（length-delimited）：校验声明长度未越界
  const len = readProtobufVarint(bytes, firstTag.nextOffset);
  if (!len || len.value < 0 || len.nextOffset + len.value > bytes.byteLength) {
    return false;
  }
  return true;
}

/**
 * 校验二进制数据是否为有效的 ONNX 模型文件
 * 拦截空文件、HTML/JSON 错误页、常见错误文件头、残缺体积及非 ONNX Protobuf 结构。
 */
export function validateOnnxModelBuffer(
  buffer: ArrayBuffer | Uint8Array,
  options?: { minBytes?: number; fileName?: string },
): ModelValidationResult {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const minBytes = options?.minBytes ?? MIN_VALID_LAMA_BYTES;

  if (bytes.byteLength === 0) {
    return { valid: false, reason: '模型文件为空（0 字节），请重新下载或选择完整的 .onnx 文件。' };
  }

  if (looksLikeTextOrHtml(bytes)) {
    return {
      valid: false,
      reason:
        '文件内容为网页或文本错误响应而非 ONNX 模型（常见于链接失效、防盗链或需登录），请切换镜像源或手动导入本地 .onnx 文件。',
    };
  }

  const wrongFormat = detectNonOnnxBinaryFormat(bytes);
  if (wrongFormat) {
    return {
      valid: false,
      reason: `检测到文件实际为 ${wrongFormat} 而非 ONNX 模型，请确认选择的是正确的 .onnx 权重文件。`,
    };
  }

  if (bytes.byteLength < minBytes) {
    const actualKB = Math.max(1, Math.round(bytes.byteLength / 1024));
    const minMB = (minBytes / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      reason: `模型文件体积过小（仅 ${actualKB} KB，预期至少 ${minMB} MB），可能下载不完整或文件已损坏。`,
    };
  }

  if (!hasValidOnnxProtobufHeader(bytes)) {
    const label = options?.fileName ? `「${options.fileName}」` : '该文件';
    return {
      valid: false,
      reason: `${label}不符合 ONNX 模型二进制格式（ModelProto 头部校验失败），请确认导入的是未压缩的 .onnx 文件。`,
    };
  }

  return { valid: true };
}

/** 校验用户输入的模型下载 URL */
export function validateModelUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new LamaModelError(
      'INVALID_URL',
      '请输入有效的模型下载地址（需以 https:// 或 http:// 开头）。',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new LamaModelError('INVALID_URL', '模型下载地址格式无效，请检查完整链接后重试。');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new LamaModelError('INVALID_URL', '模型下载地址仅支持 http:// 或 https:// 协议。');
  }
  return parsed.href;
}

/** 判断异常是否为用户主动中止（AbortError） */
function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  return false;
}

/** 根据 HTTP 状态码生成面向用户的中文错误说明 */
function buildHttpErrorMessage(status: number, statusText: string): string {
  if (status === 404) {
    return '模型下载失败（HTTP 404）：目标权重文件不存在或路径已变更，请切换其他镜像源。';
  }
  if (status === 401 || status === 403) {
    return `模型下载失败（HTTP ${status}）：目标仓库拒绝访问或需要鉴权，请切换公开镜像源或手动导入本地 .onnx 模型。`;
  }
  if (status === 429) {
    return '模型下载失败（HTTP 429）：请求过于频繁被限流，请稍后重试或切换其他下载源。';
  }
  if (status >= 500) {
    return `模型下载失败（HTTP ${status}）：远端镜像服务暂时不可用，请切换备用下载源重试。`;
  }
  const detail = statusText ? ` ${statusText}` : '';
  return `模型下载失败（HTTP ${status}${detail}），请检查网络或更换下载源。`;
}

/** 检查响应头 Content-Type 是否明确为非二进制文本/网页 */
function isDisallowedTextContentType(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes('text/html') ||
    normalized.includes('application/xhtml') ||
    normalized.includes('application/json') ||
    normalized.includes('text/plain')
  );
}

/**
 * 流式下载 ONNX 模型文件并校验完整性
 * 支持 ReadableStream 实时进度、AbortController 取消，区分网络/CORS、HTTP 错误、取消与文件无效。
 */
export async function downloadModel(
  url: string,
  options: DownloadModelOptions = {},
): Promise<ArrayBuffer> {
  const normalizedUrl = validateModelUrl(url);
  const { onProgress, signal, minBytes } = options;

  if (signal?.aborted) {
    throw new LamaModelError('ABORTED', '已取消模型下载。');
  }

  let response: Response;
  try {
    response = await fetch(normalizedUrl, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      signal,
    });
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw new LamaModelError('ABORTED', '已取消模型下载。');
    }
    throw new LamaModelError(
      'NETWORK_OR_CORS',
      '模型下载失败：网络连接异常或目标站点限制浏览器跨域访问（CORS）。建议切换国内镜像源，或手动下载后通过「导入本地 .onnx 模型」加载。',
    );
  }

  if (!response.ok) {
    throw new LamaModelError(
      'HTTP_ERROR',
      buildHttpErrorMessage(response.status, response.statusText),
      response.status,
    );
  }

  const contentType = response.headers.get('content-type');
  if (isDisallowedTextContentType(contentType)) {
    try {
      await response.body?.cancel();
    } catch {
      // 忽略取消流时的次级错误
    }
    throw new LamaModelError(
      'INVALID_MODEL',
      `下载源返回了非二进制内容（${contentType}），可能遇到网页跳转或错误页，请切换下载源。`,
    );
  }

  const contentLengthHeader = response.headers.get('content-length');
  const parsedTotal = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : NaN;
  const totalBytes = Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : undefined;

  let mergedBytes: Uint8Array<ArrayBuffer>;

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loadedBytes = 0;
    let lastReportTime = 0;
    let checkedFirstChunk = false;

    const emitProgress = (force: boolean) => {
      if (!onProgress) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastReportTime < 80) {
        return;
      }
      lastReportTime = now;
      const percent = totalBytes
        ? Math.min(100, Math.round((loadedBytes / totalBytes) * 1000) / 10)
        : undefined;
      onProgress({ loadedBytes, totalBytes, percent });
    };

    try {
      emitProgress(true);
      while (true) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => undefined);
          throw new LamaModelError('ABORTED', '已取消模型下载。');
        }

        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.byteLength === 0) {
          continue;
        }

        // 首包快速嗅探：若服务端以 application/octet-stream 返回 HTML 错误页，立即终止避免白耗流量
        if (!checkedFirstChunk) {
          checkedFirstChunk = true;
          if (looksLikeTextOrHtml(value)) {
            await reader.cancel().catch(() => undefined);
            throw new LamaModelError(
              'INVALID_MODEL',
              '下载内容为网页或文本错误响应而非 ONNX 模型，请切换镜像源或手动导入本地 .onnx 文件。',
            );
          }
        }

        chunks.push(value);
        loadedBytes += value.byteLength;
        emitProgress(false);
      }
      emitProgress(true);
    } catch (error) {
      if (error instanceof LamaModelError) {
        throw error;
      }
      if (isAbortError(error, signal)) {
        throw new LamaModelError('ABORTED', '已取消模型下载。');
      }
      throw new LamaModelError(
        'NETWORK_OR_CORS',
        '模型下载过程中网络连接中断，请检查网络稳定性后重试，或手动导入本地 .onnx 文件。',
      );
    }

    // 合并所有分片为连续 ArrayBuffer
    mergedBytes = new Uint8Array(new ArrayBuffer(loadedBytes));
    let offset = 0;
    for (const chunk of chunks) {
      mergedBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    // 兼容无 ReadableStream 的降级读取
    try {
      const arrayBuffer = await response.arrayBuffer();
      mergedBytes = new Uint8Array(arrayBuffer);
      onProgress?.({
        loadedBytes: mergedBytes.byteLength,
        totalBytes: totalBytes ?? mergedBytes.byteLength,
        percent: 100,
      });
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw new LamaModelError('ABORTED', '已取消模型下载。');
      }
      throw new LamaModelError('NETWORK_OR_CORS', '读取模型下载响应流失败，请检查网络连接后重试。');
    }
  }

  // 若服务端明确给出 Content-Length 且接收字节不足，判定传输截断
  if (totalBytes !== undefined && mergedBytes.byteLength < totalBytes) {
    throw new LamaModelError(
      'NETWORK_OR_CORS',
      `模型下载不完整（已接收 ${(mergedBytes.byteLength / (1024 * 1024)).toFixed(1)} MB / 共 ${(totalBytes / (1024 * 1024)).toFixed(1)} MB），请重新下载。`,
    );
  }

  const validation = validateOnnxModelBuffer(mergedBytes, { minBytes });
  if (!validation.valid) {
    throw new LamaModelError('INVALID_MODEL', validation.reason);
  }

  return mergedBytes.buffer;
}

/**
 * 校验并导入用户选择的本地 .onnx 模型文件到 IndexedDB
 */
export async function importLocalModelFile(
  file: File,
  options?: { minBytes?: number },
): Promise<CachedModelMeta> {
  if (!file) {
    throw new LamaModelError('INVALID_MODEL', '未选择任何模型文件。');
  }

  if (!file.name.toLowerCase().endsWith('.onnx')) {
    throw new LamaModelError(
      'INVALID_MODEL',
      `仅支持导入 .onnx 格式的 LaMa 模型文件，当前文件为「${file.name}」。`,
    );
  }

  const minBytes = options?.minBytes ?? MIN_VALID_LAMA_BYTES;
  if (file.size === 0) {
    throw new LamaModelError(
      'INVALID_MODEL',
      `文件「${file.name}」为空（0 字节），请选择完整的模型文件。`,
    );
  }

  if (file.size < minBytes) {
    const actualKB = Math.max(1, Math.round(file.size / 1024));
    const minMB = (minBytes / (1024 * 1024)).toFixed(1);
    throw new LamaModelError(
      'INVALID_MODEL',
      `文件「${file.name}」体积过小（仅 ${actualKB} KB，预期至少 ${minMB} MB），可能并非完整的 LaMa ONNX 权重。`,
    );
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throw new LamaModelError(
      'INVALID_MODEL',
      `读取本地文件「${file.name}」失败，请确认文件可读后重试。`,
    );
  }

  const validation = validateOnnxModelBuffer(buffer, { minBytes, fileName: file.name });
  if (!validation.valid) {
    throw new LamaModelError('INVALID_MODEL', validation.reason);
  }

  try {
    return await saveModelToCache({
      buffer,
      sourceLabel: `本地模型 · ${file.name}`,
      sourceUrl: `local://${file.name}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '缓存本地模型到浏览器存储失败。';
    throw new LamaModelError('STORAGE_ERROR', message);
  }
}
