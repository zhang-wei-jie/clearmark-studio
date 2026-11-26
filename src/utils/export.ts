import JSZip from 'jszip';
import type { ExportConfig, ExportFormat, ImageItem } from '../types';

const FORMAT_META: Record<ExportFormat, { mime: string; ext: string }> = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  webp: { mime: 'image/webp', ext: 'webp' },
};

/** 清理文件名中的非法路径字符并按配置拼接后缀与扩展名 */
export function buildExportFilename(originalName: string, config: ExportConfig): string {
  const sanitized = originalName
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.+$/, '');
  const baseName = sanitized.replace(/\.[^.]+$/, '') || 'image';
  const suffix = config.filenameSuffix.replace(/[\\/:*?"<>|]/g, '_');
  const ext = FORMAT_META[config.format].ext;
  return `${baseName}${suffix}.${ext}`;
}

/** 异步加载图片 URL / DataURL 为 HTMLImageElement */
export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败，请检查文件是否损坏或格式不受支持'));
    img.src = src;
  });
}

/** 从图片 URL 读取完整原分辨率的 ImageData */
export async function imageSourceToImageData(src: string): Promise<ImageData> {
  const img = await loadImageElement(src);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('浏览器无法创建 Canvas 2D 绘图上下文');
  }

  ctx.drawImage(img, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** 将 ImageData 无损编码为 PNG DataURL（保持完整原分辨率） */
export function imageDataToDataUrl(imageData: ImageData, mimeType = 'image/png'): string {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('浏览器无法创建 Canvas 2D 绘图上下文');
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL(mimeType);
}

/**
 * 将 ImageData 无损编码为 Blob ObjectURL（相较 Base64 DataURL 节省约 33% 内存且脱离 JS 字符串堆），
 * 当运行环境不支持 canvas.toBlob 或 URL.createObjectURL 时安全回退到 DataURL。
 * 调用方在历史节点淘汰或图片移除时应负责调用 URL.revokeObjectURL 回收内存。
 */
export async function imageDataToBlobUrl(
  imageData: ImageData,
  mimeType = 'image/png',
): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('浏览器无法创建 Canvas 2D 绘图上下文');
  }
  ctx.putImageData(imageData, 0, 0);

  if (typeof canvas.toBlob === 'function' && typeof URL.createObjectURL === 'function') {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), mimeType);
    });
    if (blob) {
      return URL.createObjectURL(blob);
    }
  }

  return canvas.toDataURL(mimeType);
}

/**
 * 按原图分辨率将画面重新编码为目标格式 Blob。
 * 通过 Canvas 重编码会天然剥离 EXIF、XMP、IPTC 与平台 AIGC 元信息。
 */
export async function exportImageToBlob(
  sourceUrl: string,
  config: ExportConfig,
): Promise<{
  blob: Blob;
  filenameSuffix: string;
  mimeType: string;
  width: number;
  height: number;
}> {
  const img = await loadImageElement(sourceUrl);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  const meta = FORMAT_META[config.format];

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('无法创建导出画布上下文');
  }

  // JPEG 不支持透明通道，导出前填充纯白底避免透明区变黑
  if (config.format === 'jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }

  ctx.drawImage(img, 0, 0, width, height);

  const quality = config.format === 'png' ? undefined : Math.min(1, Math.max(0.1, config.quality));

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (!result) {
          reject(new Error(`无法编码为 ${config.format.toUpperCase()} 格式`));
          return;
        }
        resolve(result);
      },
      meta.mime,
      quality,
    );
  });

  return {
    blob,
    filenameSuffix: config.filenameSuffix,
    mimeType: meta.mime,
    width,
    height,
  };
}

/** 触发浏览器文件下载并及时释放临时 ObjectURL */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1500);
}

/** 导出并下载单张图片（保持原图分辨率） */
export async function downloadSingleImage(
  item: Pick<ImageItem, 'name' | 'currentDataUrl'>,
  config: ExportConfig,
): Promise<string> {
  const filename = buildExportFilename(item.name, config);
  const { blob } = await exportImageToBlob(item.currentDataUrl, config);
  triggerBlobDownload(blob, filename);
  return filename;
}

/** 将当前图片以 PNG 无损格式复制到系统剪贴板 */
export async function copyImageToClipboard(sourceUrl: string): Promise<void> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.clipboard ||
    typeof navigator.clipboard.write !== 'function' ||
    typeof ClipboardItem === 'undefined'
  ) {
    throw new Error('当前浏览器或页面环境不支持直接复制图片到剪贴板，请使用下载功能');
  }

  const { blob } = await exportImageToBlob(sourceUrl, {
    format: 'png',
    quality: 1,
    filenameSuffix: '',
    stripMetadata: true,
  });

  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

export interface BatchZipOptions {
  /** 导出进度回调（已完成数、总数、当前文件名） */
  onProgress?: (completed: number, total: number, currentName: string) => void;
  /** 外部中止信号 */
  signal?: AbortSignal;
  /** 自定义 ZIP 包文件名 */
  zipFileName?: string;
}

/** 处理批量打包中的重名冲突，自动追加序号 */
export function deduplicateFilename(filename: string, usedNames: Set<string>): string {
  if (!usedNames.has(filename)) {
    usedNames.add(filename);
    return filename;
  }

  const dotIdx = filename.lastIndexOf('.');
  const stem = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
  const ext = dotIdx > 0 ? filename.slice(dotIdx) : '';

  let counter = 2;
  let candidate = `${stem}_${counter}${ext}`;
  while (usedNames.has(candidate)) {
    counter++;
    candidate = `${stem}_${counter}${ext}`;
  }
  usedNames.add(candidate);
  return candidate;
}

/** 将多张图片按原分辨率打包为 ZIP 并触发下载 */
export async function exportBatchAsZip(
  items: Array<Pick<ImageItem, 'id' | 'name' | 'currentDataUrl'>>,
  config: ExportConfig,
  options?: BatchZipOptions,
): Promise<{ blob: Blob; filename: string; count: number }> {
  if (items.length === 0) {
    throw new Error('没有可打包导出的图片');
  }

  const zip = new JSZip();
  const usedNames = new Set<string>();
  const total = items.length;

  for (let i = 0; i < total; i++) {
    if (options?.signal?.aborted) {
      throw new DOMException('已取消批量导出', 'AbortError');
    }

    const item = items[i];
    const rawFilename = buildExportFilename(item.name, config);
    const uniqueFilename = deduplicateFilename(rawFilename, usedNames);

    const { blob } = await exportImageToBlob(item.currentDataUrl, config);
    zip.file(uniqueFilename, blob);
    options?.onProgress?.(i + 1, total, uniqueFilename);
  }

  if (options?.signal?.aborted) {
    throw new DOMException('已取消批量导出', 'AbortError');
  }

  // 图片本身已是压缩编码，使用 STORE 模式打包速度最快且不增加额外体积
  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'STORE',
  });

  const now = new Date();
  const dateStamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  const zipFileName = options?.zipFileName ?? `净影去水印_批量导出_${dateStamp}.zip`;
  triggerBlobDownload(zipBlob, zipFileName);

  return {
    blob: zipBlob,
    filename: zipFileName,
    count: total,
  };
}
