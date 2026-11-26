/**
 * 画布工具、选区遮罩、平台/自定义预设与智能检测/紧贴笔画领域 Actions
 */

import {
  createCustomPresetFromRect,
  deleteCustomPreset,
  getAllPresets,
  presetToPrimaryNormalizedRect,
  saveCustomPreset,
} from '../../data/presets';
import { runCornerAutoDetect, runMaskStrokeRefine } from '../../engines/fast';
import type {
  CornerDetectionResult,
  DetectSensitivity,
  NormalizedRect,
  StrokeRefineResult,
  ToolType,
  WatermarkPreset,
} from '../../types';
import { imageSourceToImageData } from '../../utils/export';
import {
  applyNormalizedRectToMask,
  cloneMask,
  createEmptyMask,
  createMaskFromPreset,
  dilateMask,
  getMaskNormalizedBoundingBox,
  hasMaskPixels,
  scaleMaskToSize,
} from '../../utils/maskUtils';
import { extractErrorMessage, resolveEffectiveMask } from '../history';
import type { CompareMode, StoreActionContext } from '../types';

export interface MaskPresetActions {
  setTool: (tool: ToolType) => void;
  setBrushSize: (size: number) => void;
  setFeatherPx: (px: number) => void;
  setMaskOpacity: (opacity: number) => void;
  setShowMask: (show: boolean) => void;
  setCompareMode: (mode: CompareMode) => void;
  updateActiveMask: (mask: Uint8Array | null) => void;
  setActivePresetBox: (rect: NormalizedRect | null) => void;
  commitActivePresetBoxToMask: (keepBox?: boolean) => void;
  dilateActiveMask: (radiusPx?: number) => void;
  refineActiveMaskToStrokes: () => Promise<StrokeRefineResult | null>;
  clearActiveMask: () => void;
  applyPresetToActive: (presetId: string) => void;
  openPresetBoxForActive: (presetId?: string) => void;
  applyPresetToAll: (presetId: string) => void;
  applyActivePresetBoxToAll: () => void;
  applyActiveMaskToAll: () => void;
  saveCurrentBoxAsCustomPreset: (name: string, description?: string) => WatermarkPreset | null;
  removeCustomPreset: (id: string) => void;
  setDetectSensitivity: (sensitivity: DetectSensitivity) => void;
  autoDetectActive: () => Promise<CornerDetectionResult | null>;
  autoDetectAll: () => Promise<{ detectedCount: number; total: number }>;
}

export function createMaskPresetActions(ctx: StoreActionContext): MaskPresetActions {
  const { getState, dispatch, refs, getActiveImage, pushToast } = ctx;

  const openPresetBoxForActive = (presetId?: string) => {
    const active = getActiveImage();
    if (!active) {
      pushToast('warning', '请先导入一张图片');
      return;
    }

    const state = getState();
    const targetPresetId = presetId ?? state.selectedPresetId;
    const preset = targetPresetId ? state.presets.find((p) => p.id === targetPresetId) : undefined;

    let rect: NormalizedRect;
    if (preset) {
      rect = presetToPrimaryNormalizedRect(preset, active.width, active.height);
      dispatch({ type: 'SET_SELECTED_PRESET_ID', id: preset.id });
    } else {
      const maskNorm = getMaskNormalizedBoundingBox(active.maskBytes, active.width, active.height);
      rect = maskNorm ?? { x: 0.78, y: 0.88, width: 0.2, height: 0.095 };
    }

    dispatch({
      type: 'UPDATE_IMAGE',
      id: active.id,
      updater: (item) => ({ ...item, activePresetBox: rect }),
    });
    dispatch({ type: 'SET_TOOL', tool: 'preset-box' });
  };

  const setTool = (tool: ToolType) => {
    dispatch({ type: 'SET_TOOL', tool });
    if (tool === 'preset-box') {
      const active = getActiveImage();
      if (active && !active.activePresetBox) {
        openPresetBoxForActive();
      }
    }
  };

  const setBrushSize = (size: number) => {
    dispatch({ type: 'SET_BRUSH_SIZE', size });
  };

  const setFeatherPx = (px: number) => {
    dispatch({ type: 'SET_FEATHER_PX', px });
  };

  const setMaskOpacity = (opacity: number) => {
    dispatch({ type: 'SET_MASK_OPACITY', opacity });
  };

  const setShowMask = (show: boolean) => {
    dispatch({ type: 'SET_SHOW_MASK', show });
  };

  const setCompareMode = (mode: CompareMode) => {
    dispatch({ type: 'SET_COMPARE_MODE', mode });
  };

  const updateActiveMask = (mask: Uint8Array | null) => {
    const activeId = getState().activeImageId;
    if (!activeId) return;
    const valid = hasMaskPixels(mask);
    dispatch({
      type: 'UPDATE_IMAGE',
      id: activeId,
      updater: (item) => ({
        ...item,
        maskBytes: valid ? mask : null,
        // 手动涂抹、框选或擦除后立即清除模板精准对齐元信息，避免 Fast 引擎误放大非水印区
        matchedMarks: undefined,
      }),
    });
  };

  const setActivePresetBox = (rect: NormalizedRect | null) => {
    const activeId = getState().activeImageId;
    if (!activeId) return;
    dispatch({
      type: 'UPDATE_IMAGE',
      id: activeId,
      updater: (item) => ({
        ...item,
        activePresetBox: rect,
      }),
    });
  };

  const commitActivePresetBoxToMask = (keepBox = false) => {
    const active = getActiveImage();
    if (!active || !active.activePresetBox) {
      return;
    }

    const nextMask = active.maskBytes
      ? cloneMask(active.maskBytes)
      : createEmptyMask(active.width, active.height);
    applyNormalizedRectToMask(nextMask, active.width, active.height, active.activePresetBox, 255);

    dispatch({
      type: 'UPDATE_IMAGE',
      id: active.id,
      updater: (item) => ({
        ...item,
        maskBytes: hasMaskPixels(nextMask) ? nextMask : null,
        matchedMarks: undefined,
        activePresetBox: keepBox ? item.activePresetBox : null,
      }),
    });
    if (!keepBox) {
      dispatch({ type: 'SET_TOOL', tool: 'brush' });
    }
    pushToast('success', '已将预设框应用到当前选区');
  };

  const dilateActiveMask = (radiusPx = 4) => {
    const active = getActiveImage();
    const effectiveMask = active ? resolveEffectiveMask(active) : null;
    if (!active || !effectiveMask) {
      pushToast('warning', '请先绘制或套用遮罩选区后再外扩');
      return;
    }
    const expanded = dilateMask(effectiveMask, active.width, active.height, radiusPx);
    dispatch({
      type: 'UPDATE_IMAGE',
      id: active.id,
      updater: (item) => ({
        ...item,
        maskBytes: hasMaskPixels(expanded) ? expanded : null,
        matchedMarks: undefined,
        activePresetBox: null,
      }),
    });
    pushToast('info', `已将选区向外扩展 ${radiusPx}px`);
  };

  const refineActiveMaskToStrokes = async (): Promise<StrokeRefineResult | null> => {
    const active = getActiveImage();
    if (!active) {
      pushToast('warning', '请先导入一张图片');
      return null;
    }
    const cur = getState();
    if (cur.isRefiningMask || cur.isDetecting || cur.isProcessing) {
      return null;
    }
    const effectiveMask = resolveEffectiveMask(active);
    if (!effectiveMask) {
      pushToast('warning', '请先框选水印区域或套用平台预设后再提取笔画');
      return null;
    }

    const taskGen = ++refs.refineTaskGen;
    const targetId = active.id;
    const snapshotUrl = active.currentDataUrl;

    dispatch({ type: 'SET_IS_REFINING_MASK', value: true });
    try {
      const imageData = await imageSourceToImageData(snapshotUrl);
      const result = await runMaskStrokeRefine(imageData, effectiveMask);

      // 校验异步返回时任务未被队列清空作废、目标图仍在队列且画面版本未发生切换
      if (refs.refineTaskGen !== taskGen) {
        return null;
      }
      const latest = getState().images.find((img) => img.id === targetId);
      if (!latest || latest.currentDataUrl !== snapshotUrl) {
        return null;
      }

      if (result.refined && hasMaskPixels(result.mask)) {
        dispatch({
          type: 'UPDATE_IMAGE',
          id: targetId,
          updater: (item) => ({
            ...item,
            maskBytes: result.mask,
            matchedMarks: result.matchedMarks,
            activePresetBox: null,
          }),
        });
        dispatch({ type: 'SET_SHOW_MASK', show: true });
        pushToast('success', result.message);
      } else {
        pushToast('info', result.message);
      }
      return result;
    } catch (err) {
      if (refs.refineTaskGen === taskGen) {
        pushToast('error', extractErrorMessage(err, '框内智能提取水印笔画失败'));
      }
      return null;
    } finally {
      if (refs.refineTaskGen === taskGen) {
        dispatch({ type: 'SET_IS_REFINING_MASK', value: false });
      }
    }
  };

  const clearActiveMask = () => {
    const activeId = getState().activeImageId;
    if (!activeId) return;
    dispatch({
      type: 'UPDATE_IMAGE',
      id: activeId,
      updater: (item) => ({
        ...item,
        maskBytes: null,
        matchedMarks: undefined,
        activePresetBox: null,
      }),
    });
    dispatch({ type: 'SET_LAST_DETECTION', result: null });
  };

  const applyPresetToActive = (presetId: string) => {
    const active = getActiveImage();
    if (!active) {
      pushToast('warning', '请先导入一张图片');
      return;
    }
    const preset = getState().presets.find((p) => p.id === presetId);
    if (!preset) {
      return;
    }

    const mask = createMaskFromPreset(preset, active.width, active.height);
    dispatch({ type: 'SET_SELECTED_PRESET_ID', id: preset.id });
    dispatch({
      type: 'UPDATE_IMAGE',
      id: active.id,
      updater: (item) => ({
        ...item,
        maskBytes: hasMaskPixels(mask) ? mask : null,
        matchedMarks: undefined,
        activePresetBox: null,
      }),
    });
    dispatch({ type: 'SET_SHOW_MASK', show: true });
    pushToast('success', `已套用预设「${preset.name}」`);
  };

  const applyPresetToAll = (presetId: string) => {
    const { images, presets } = getState();
    if (images.length === 0) {
      pushToast('warning', '当前图片队列为空');
      return;
    }
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) {
      return;
    }

    dispatch({ type: 'SET_SELECTED_PRESET_ID', id: preset.id });
    dispatch({
      type: 'UPDATE_ALL_IMAGES',
      updater: (item) => {
        const nextMask = createMaskFromPreset(preset, item.width, item.height);
        return {
          ...item,
          maskBytes: hasMaskPixels(nextMask) ? nextMask : null,
          matchedMarks: undefined,
          activePresetBox: null,
        };
      },
    });
    dispatch({ type: 'SET_SHOW_MASK', show: true });
    pushToast(
      'success',
      `已将预设「${preset.name}」按画幅自适应套用到全部 ${images.length} 张图片`,
    );
  };

  const applyActivePresetBoxToAll = () => {
    const active = getActiveImage();
    const { images } = getState();
    if (!active || !active.activePresetBox || images.length === 0) {
      return;
    }

    const box = active.activePresetBox;
    dispatch({
      type: 'UPDATE_ALL_IMAGES',
      updater: (item) => {
        const nextMask = createEmptyMask(item.width, item.height);
        applyNormalizedRectToMask(nextMask, item.width, item.height, box, 255);
        return {
          ...item,
          maskBytes: hasMaskPixels(nextMask) ? nextMask : null,
          matchedMarks: undefined,
          activePresetBox: null,
        };
      },
    });
    dispatch({ type: 'SET_TOOL', tool: 'brush' });
    dispatch({ type: 'SET_SHOW_MASK', show: true });
    pushToast('success', `已将当前精调框比例应用到全部 ${images.length} 张图片`);
  };

  const applyActiveMaskToAll = () => {
    const active = getActiveImage();
    const { images, selectedPresetId } = getState();
    if (images.length === 0) {
      pushToast('warning', '当前图片队列为空');
      return;
    }

    if (active?.activePresetBox) {
      applyActivePresetBoxToAll();
      return;
    }

    if (active && hasMaskPixels(active.maskBytes)) {
      const srcMask = active.maskBytes!;
      const srcW = active.width;
      const srcH = active.height;
      dispatch({
        type: 'UPDATE_ALL_IMAGES',
        updater: (item) => {
          const scaled = scaleMaskToSize(srcMask, srcW, srcH, item.width, item.height);
          return {
            ...item,
            maskBytes: hasMaskPixels(scaled) ? scaled : null,
            matchedMarks: undefined,
            activePresetBox: null,
          };
        },
      });
      dispatch({ type: 'SET_SHOW_MASK', show: true });
      pushToast('success', `已将当前选区按比例映射至全部 ${images.length} 张图片`);
      return;
    }

    if (selectedPresetId) {
      applyPresetToAll(selectedPresetId);
      return;
    }

    pushToast('warning', '请先在当前图片上套用预设、绘制选区或框选水印位置');
  };

  const saveCurrentBoxAsCustomPreset = (
    name: string,
    description?: string,
  ): WatermarkPreset | null => {
    const active = getActiveImage();
    if (!active) {
      pushToast('warning', '请先打开一张图片');
      return null;
    }

    const rect =
      active.activePresetBox ??
      getMaskNormalizedBoundingBox(active.maskBytes, active.width, active.height);

    if (!rect) {
      pushToast('warning', '当前没有可保存的水印选区或预设框');
      return null;
    }

    const created = createCustomPresetFromRect(name, rect, description);
    saveCustomPreset(created);
    const refreshed = getAllPresets();
    dispatch({ type: 'SET_PRESETS', presets: refreshed });
    dispatch({ type: 'SET_SELECTED_PRESET_ID', id: created.id });
    pushToast('success', `已保存自定义预设「${created.name}」`);
    return created;
  };

  const removeCustomPreset = (id: string) => {
    deleteCustomPreset(id);
    const refreshed = getAllPresets();
    dispatch({ type: 'SET_PRESETS', presets: refreshed });
    if (getState().selectedPresetId === id) {
      dispatch({ type: 'SET_SELECTED_PRESET_ID', id: null });
    }
    pushToast('info', '已删除自定义预设');
  };

  const setDetectSensitivity = (sensitivity: DetectSensitivity) => {
    dispatch({ type: 'SET_DETECT_SENSITIVITY', sensitivity });
  };

  const autoDetectActive = async (): Promise<CornerDetectionResult | null> => {
    const active = getActiveImage();
    if (!active) {
      pushToast('warning', '请先导入需要检测的图片');
      return null;
    }
    const cur = getState();
    if (cur.isDetecting || cur.isRefiningMask || cur.isProcessing) {
      return null;
    }

    const taskGen = ++refs.detectTaskGen;
    const targetId = active.id;
    const snapshotUrl = active.currentDataUrl;

    dispatch({ type: 'SET_IS_DETECTING', value: true });
    try {
      const imageData = await imageSourceToImageData(snapshotUrl);
      const result = await runCornerAutoDetect(imageData, getState().detectSensitivity);

      if (refs.detectTaskGen !== taskGen) {
        return null;
      }
      const latest = getState().images.find((img) => img.id === targetId);
      if (!latest || latest.currentDataUrl !== snapshotUrl) {
        return null;
      }

      const stillActive = getState().activeImageId === targetId;
      if (stillActive) {
        dispatch({ type: 'SET_LAST_DETECTION', result });
      }

      if (result.detected && result.mask && hasMaskPixels(result.mask)) {
        dispatch({
          type: 'UPDATE_IMAGE',
          id: targetId,
          updater: (item) => ({
            ...item,
            maskBytes: result.mask!,
            matchedMarks: result.matches,
            activePresetBox: null,
          }),
        });
        if (stillActive) {
          dispatch({ type: 'SET_SHOW_MASK', show: true });
          pushToast('success', result.message);
        }
      } else if (stillActive) {
        pushToast('info', result.message);
      }
      return result;
    } catch (err) {
      if (refs.detectTaskGen === taskGen) {
        pushToast('error', extractErrorMessage(err, '自动检测角落水印失败'));
      }
      return null;
    } finally {
      if (refs.detectTaskGen === taskGen) {
        dispatch({ type: 'SET_IS_DETECTING', value: false });
      }
    }
  };

  const autoDetectAll = async (): Promise<{ detectedCount: number; total: number }> => {
    const cur = getState();
    const targets = cur.images;
    if (targets.length === 0) {
      pushToast('warning', '当前图片队列为空');
      return { detectedCount: 0, total: 0 };
    }
    if (cur.isDetecting || cur.isRefiningMask || cur.isProcessing) {
      return { detectedCount: 0, total: targets.length };
    }

    const taskGen = ++refs.detectTaskGen;
    dispatch({ type: 'SET_IS_DETECTING', value: true });
    let detectedCount = 0;

    try {
      for (const item of targets) {
        if (refs.detectTaskGen !== taskGen) {
          return { detectedCount, total: targets.length };
        }
        const currentItem = getState().images.find((img) => img.id === item.id);
        if (!currentItem) {
          continue;
        }
        const snapshotUrl = currentItem.currentDataUrl;

        try {
          const imageData = await imageSourceToImageData(snapshotUrl);
          const result = await runCornerAutoDetect(imageData, getState().detectSensitivity);
          if (refs.detectTaskGen !== taskGen) {
            return { detectedCount, total: targets.length };
          }
          const latest = getState().images.find((img) => img.id === item.id);
          if (!latest || latest.currentDataUrl !== snapshotUrl) {
            continue;
          }
          if (item.id === getState().activeImageId) {
            dispatch({ type: 'SET_LAST_DETECTION', result });
          }
          if (result.detected && result.mask && hasMaskPixels(result.mask)) {
            detectedCount++;
            dispatch({
              type: 'UPDATE_IMAGE',
              id: item.id,
              updater: (prev) => ({
                ...prev,
                maskBytes: result.mask!,
                matchedMarks: result.matches,
                activePresetBox: null,
              }),
            });
          }
        } catch {
          // 单张检测异常时继续检测其余图片
        }
      }

      if (refs.detectTaskGen !== taskGen) {
        return { detectedCount, total: targets.length };
      }

      if (detectedCount > 0) {
        dispatch({ type: 'SET_SHOW_MASK', show: true });
        pushToast(
          'success',
          `批量检测完成：${detectedCount} / ${targets.length} 张已自动标出角落水印`,
        );
      } else {
        pushToast(
          'info',
          `批量检测完成：未在 ${targets.length} 张图片中发现明显角落水印，可改用平台预设或手动涂抹`,
        );
      }
      return { detectedCount, total: targets.length };
    } finally {
      if (refs.detectTaskGen === taskGen) {
        dispatch({ type: 'SET_IS_DETECTING', value: false });
      }
    }
  };

  return {
    setTool,
    setBrushSize,
    setFeatherPx,
    setMaskOpacity,
    setShowMask,
    setCompareMode,
    updateActiveMask,
    setActivePresetBox,
    commitActivePresetBoxToMask,
    dilateActiveMask,
    refineActiveMaskToStrokes,
    clearActiveMask,
    applyPresetToActive,
    openPresetBoxForActive,
    applyPresetToAll,
    applyActivePresetBoxToAll,
    applyActiveMaskToAll,
    saveCurrentBoxAsCustomPreset,
    removeCustomPreset,
    setDetectSensitivity,
    autoDetectActive,
    autoDetectAll,
  };
}
