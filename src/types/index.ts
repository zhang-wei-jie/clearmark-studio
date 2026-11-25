/**
 * 净影去水印 · 全项目统一类型契约
 * 所有引擎模块、工具模块、全局状态与 UI 组件均以此文件为准。
 */

/** 去水印修复引擎类型：快速轻量引擎 / 内置 MI-GAN 本地 AI / 可选 LaMa 高阶 AI */
export type EngineType = 'fast' | 'migan' | 'lama';

/** 快速引擎修复质量档位：标准（毫秒级）/ 精细（更高调和收敛精度与微纹理搜索） */
export type FastQuality = 'standard' | 'high';

/** 智能角落水印探测灵敏度 */
export type DetectSensitivity = 'low' | 'medium' | 'high';

/** 画布交互工具类型 */
export type ToolType = 'brush' | 'rect' | 'eraser' | 'preset-box' | 'hand';

/** 常见水印角落锚点 */
export type CornerAnchor =
  'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'bottom-center';

/** 界面主题模式 */
export type ThemeMode = 'dark' | 'light';

/** 归一化矩形区域（所有值位于 0~1，与原图宽高比例绑定） */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 整数像素矩形区域 */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 平台预设中的单个水印区域自适应规则 */
export interface PresetRegionRule {
  /** 水印所在锚点位置 */
  anchor: CornerAnchor;
  /** 相对图像宽度的建议比例 (0~1) */
  widthRatio: number;
  /** 相对图像高度的建议比例 (0~1) */
  heightRatio: number;
  /** 距离水平边缘的留白比例 (0~1) */
  marginXRatio?: number;
  /** 距离垂直边缘的留白比例 (0~1) */
  marginYRatio?: number;
  /** 最小像素宽度保护，避免小图区域过窄 */
  minWidthPx?: number;
  /** 最大像素宽度保护，避免 4K 大图区域过大 */
  maxWidthPx?: number;
  /** 最小像素高度保护 */
  minHeightPx?: number;
  /** 最大像素高度保护 */
  maxHeightPx?: number;
  /** 自定义预设可直接指定归一化矩形，跳过锚点比例计算 */
  fixedNormalizedRect?: NormalizedRect;
}

/** 支持的水印平台分类 */
export type WatermarkPlatform = 'jimeng' | 'kling' | 'doubao' | 'tongyi' | 'generic' | 'custom';

/** 内置精确水印模板标识 */
export type WatermarkTemplateId = 'jimeng' | 'kling' | 'kling30' | 'doubao';

/** 单个精准模板命中的角标信息（用于笔画级遮罩与半透明逆向还原） */
export interface MatchedWatermark {
  templateId: WatermarkTemplateId;
  brand: 'jimeng' | 'kling' | 'doubao';
  label: string;
  corner: CornerAnchor;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 匹配得分（0~1） */
  score: number;
  /** 水印亮度极性：1 为浅色水印，-1 为亮底深色水印 */
  polarity: 1 | -1;
}

/** 水印平台预设定义 */
export interface WatermarkPreset {
  id: string;
  /** 预设展示名称，如「即梦AI · 右下角」 */
  name: string;
  /** 所属平台标识 */
  platform: WatermarkPlatform;
  /** 所属平台中文简称 */
  platformLabel: string;
  /** 预设适用场景说明 */
  description: string;
  /** 预设对应的水印区域列表（支持双角/多区域） */
  regions: PresetRegionRule[];
  /** 是否为用户自定义持久化预设 */
  isCustom?: boolean;
  /** 自定义预设创建时间戳 */
  createdAt?: number;
}

/** 智能角落水印检测结果 */
export interface CornerDetectionResult {
  /** 是否检测到明显水印 */
  detected: boolean;
  /** 主命中的角落方位 */
  corner?: CornerAnchor;
  /** 命中的水印外接像素框（多角命中时为主命中框） */
  rect?: PixelRect;
  /** 检测置信度（0~1） */
  confidence: number;
  /** 检测生成的二值遮罩（长度 = width * height，0=保留，255=水印区域） */
  mask?: Uint8Array;
  /** 命中的精准模板列表（模板匹配路径填充，供轻量引擎做半透明逆向还原） */
  matches?: MatchedWatermark[];
  /** 实际命中的检测路径：精确模板匹配 / 通用 Top-Hat 特征探测 */
  method?: 'template' | 'generic';
  /** 面向用户的简体中文结果说明 */
  message: string;
}

/** 选区紧贴笔画优化结果 */
export interface StrokeRefineResult {
  /** 是否成功提取到明显笔画轮廓 */
  refined: boolean;
  /** 优化后的二值遮罩（未提取到时返回原遮罩拷贝） */
  mask: Uint8Array;
  /** 若在选区内直接命中了已知平台模板，则返回命中信息 */
  matchedMarks?: MatchedWatermark[];
  /** 优化前后遮罩像素面积占比变化说明 */
  message: string;
}

/** 去水印推理输入 */
export interface InpaintInput {
  /** 原始或当前待修复图像像素数据 */
  imageData: ImageData;
  /** 单通道遮罩数组（长度 = imageData.width * imageData.height，>0 表示待修复） */
  mask: Uint8Array;
  /** 快速引擎质量档位（仅 fast 引擎生效） */
  quality?: FastQuality;
  /** 边缘羽化融合像素半径，默认 3 */
  featherPx?: number;
  /** 已命中的精准模板元信息（供 fast 引擎执行半透明逆向还原与高频细节恢复） */
  matchedMarks?: MatchedWatermark[];
}

/** 修复任务进度事件 */
export interface InpaintProgress {
  /** 当前阶段简体中文描述 */
  stage: string;
  /** 完成百分比（0~100） */
  percent: number;
}

/** 去水印输出结果 */
export interface InpaintOutput {
  /** 修复后的完整分辨率图像数据（非遮罩区保持原像素无损） */
  imageData: ImageData;
  /** 实际处理耗时（毫秒） */
  durationMs: number;
  /** 实际执行后端标识，如 'fast-worker' | 'fast-main' | 'migan-wasm' | 'webgpu' | 'wasm' */
  backend: string;
}

/** 内置 MI-GAN 本地 AI 模型状态 */
export type MiganModelState = 'idle' | 'loading' | 'ready' | 'error';

/** 内置 MI-GAN 本地 AI 状态快照 */
export interface MiganModelStatus {
  state: MiganModelState;
  /** 模型加载进度（0~100） */
  progress?: number;
  /** 当前阶段中文说明 */
  stage?: string;
  /** 推理后端 */
  backend?: 'wasm';
  /** 模型体积字节数 */
  sizeBytes?: number;
  /** 异常提示 */
  error?: string;
}

/** LaMa ONNX 模型下载源配置 */
export interface LamaModelSource {
  id: string;
  label: string;
  url: string;
  description: string;
  sizeHintMB: number;
}

/** LaMa AI 模型运行状态 */
export type LamaModelState = 'unloaded' | 'downloading' | 'cached' | 'loading' | 'ready' | 'error';

/** LaMa AI 模型状态快照 */
export interface LamaModelStatus {
  state: LamaModelState;
  /** 下载或加载进度（0~100） */
  progress?: number;
  /** 已下载字节数 */
  loadedBytes?: number;
  /** 模型总字节数（服务端未返回 Content-Length 时可能不存在） */
  totalBytes?: number;
  /** 实际推理后端 */
  backend?: 'webgpu' | 'wasm';
  /** 当前缓存模型的来源标签或文件名 */
  cachedSource?: string;
  /** 当前缓存模型的字节大小 */
  cachedSizeBytes?: number;
  /** 失败或异常时的中文错误提示 */
  error?: string;
}

/** 导出图片格式 */
export type ExportFormat = 'png' | 'jpeg' | 'webp';

/** 导出配置 */
export interface ExportConfig {
  format: ExportFormat;
  /** 有损格式（JPEG/WebP）导出质量（0.1~1.0） */
  quality: number;
  /** 导出文件名后缀，例如 '_clean' */
  filenameSuffix: string;
  /** 是否通过 Canvas 重编码剥离 EXIF 与 AIGC 元信息 */
  stripMetadata: boolean;
}

/** 单张图片的撤销/重做历史记录项 */
export interface HistoryEntry {
  id: string;
  /** 当前历史节点对应的完整分辨率画面 DataURL */
  dataUrl: string;
  /** 操作名称（如「原图」「快速去水印」「AI 精修 (MI-GAN)」） */
  label: string;
  /** 生成时间戳 */
  timestamp: number;
  /** 执行该步所用的引擎 */
  engine?: EngineType;
  /** 执行耗时（毫秒） */
  durationMs?: number;
  /** 实际后端名称 */
  backend?: string;
}

/** 单张图片处理状态 */
export type ImageStatus = 'idle' | 'processing' | 'done' | 'error';

/** 队列中的图片实体 */
export interface ImageItem {
  id: string;
  /** 原始文件名 */
  name: string;
  /** 原图 URL（DataURL 或 ObjectURL，用于原图对比与重置） */
  originalUrl: string;
  /** 原图像素宽度 */
  width: number;
  /** 原图像素高度 */
  height: number;
  /** 原始 MIME 类型 */
  mimeType: string;
  /** 当前画面 DataURL（初始与原图一致，每次修复后更新） */
  currentDataUrl: string;
  /** 是否已执行过去水印修复 */
  processed: boolean;
  /** 当前处理状态 */
  status: ImageStatus;
  /** 处理失败时的错误信息 */
  error?: string;
  /** 当前激活的二值遮罩（width * height，0/255），无选区时为 null */
  maskBytes: Uint8Array | null;
  /** 当前选区关联的精准模板命中信息（手动重绘或清空选区时清除） */
  matchedMarks?: MatchedWatermark[];
  /** 当前可拖拽调整的归一化预设框 */
  activePresetBox: NormalizedRect | null;
  /** 该图片独立的撤销/重做历史栈（索引 0 固定为原图） */
  history: HistoryEntry[];
  /** 当前所处历史索引 */
  historyIndex: number;
  /** 最近一次修复耗时（毫秒） */
  lastDurationMs?: number;
  /** 最近一次修复实际后端 */
  lastBackend?: string;
}

/** 批量处理进度状态 */
export interface BatchProgress {
  running: boolean;
  total: number;
  completed: number;
  failed: number;
  currentImageId?: string;
  currentPercent: number;
}

/** 全局提示消息类型 */
export type ToastType = 'info' | 'success' | 'warning' | 'error';

/** 全局 Toast 消息 */
export interface ToastMessage {
  id: string;
  type: ToastType;
  text: string;
}

/** 内置演示样图元信息 */
export interface DemoSampleMeta {
  id: string;
  title: string;
  subtitle: string;
  fileName: string;
  width: number;
  height: number;
  /** 推荐搭配使用的平台预设 ID */
  recommendedPresetId: string;
}
