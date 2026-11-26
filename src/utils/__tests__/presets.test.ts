import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  computePresetRects,
  createCustomPresetFromRect,
  deleteCustomPreset,
  loadCustomPresets,
  normalizedRectToPixelRect,
  pixelRectToNormalizedRect,
  presetToPrimaryNormalizedRect,
  saveCustomPreset,
} from '../../data/presets';

describe('平台水印预设与自适应区域计算 (presets)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('内置预设覆盖即梦、可灵、豆包、通义万相与通用四角', () => {
    const ids = BUILTIN_PRESETS.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'jimeng-br',
        'jimeng-tl',
        'jimeng-dual',
        'kling-br',
        'kling-bl',
        'kling-tl',
        'doubao-br',
        'tongyi-br',
        'generic-br',
        'generic-bl',
        'generic-tr',
        'generic-tl',
      ]),
    );
  });

  it('不同画幅与分辨率下计算结果严格落在图像边界内', () => {
    const sizes: Array<[number, number]> = [
      [1280, 720],
      [1024, 1024],
      [720, 1280],
      [3840, 2160],
      [120, 90],
    ];

    for (const preset of BUILTIN_PRESETS) {
      for (const [w, h] of sizes) {
        const rects = computePresetRects(preset, w, h);
        expect(rects.length).toBe(preset.regions.length);
        for (const rect of rects) {
          expect(rect.x).toBeGreaterThanOrEqual(0);
          expect(rect.y).toBeGreaterThanOrEqual(0);
          expect(rect.width).toBeGreaterThanOrEqual(1);
          expect(rect.height).toBeGreaterThanOrEqual(1);
          expect(rect.x + rect.width).toBeLessThanOrEqual(w);
          expect(rect.y + rect.height).toBeLessThanOrEqual(h);
        }
      }
    }
  });

  it('即梦双角预设同时生成右下角与左上角两个互不重叠区域', () => {
    const dual = BUILTIN_PRESETS.find((p) => p.id === 'jimeng-dual');
    expect(dual).toBeDefined();

    const rects = computePresetRects(dual!, 1280, 720);
    expect(rects).toHaveLength(2);

    const [br, tl] = rects;
    // 右下角位于右下半区
    expect(br.x).toBeGreaterThan(1280 * 0.7);
    expect(br.y).toBeGreaterThan(720 * 0.7);
    // 左上角位于左上半区
    expect(tl.x).toBeLessThan(1280 * 0.1);
    expect(tl.y).toBeLessThan(720 * 0.1);
  });

  it('横图与竖图自动按画幅比例调整相对宽度占比', () => {
    const jimengBr = BUILTIN_PRESETS.find((p) => p.id === 'jimeng-br')!;
    const landscapeNorm = presetToPrimaryNormalizedRect(jimengBr, 1600, 900);
    const portraitNorm = presetToPrimaryNormalizedRect(jimengBr, 900, 1600);

    // 竖图窄画幅下文字水印宽度占比应高于横图
    expect(portraitNorm.width).toBeGreaterThan(landscapeNorm.width);
    expect(landscapeNorm.height).toBeGreaterThan(portraitNorm.height);
  });

  it('像素框与归一化框互转保持稳定与越界裁剪保护', () => {
    const norm = pixelRectToNormalizedRect({ x: 960, y: 620, width: 280, height: 80 }, 1280, 720);
    const px = normalizedRectToPixelRect(norm, 1280, 720);
    expect(Math.abs(px.x - 960)).toBeLessThanOrEqual(1);
    expect(Math.abs(px.y - 620)).toBeLessThanOrEqual(1);
    expect(Math.abs(px.width - 280)).toBeLessThanOrEqual(1);
    expect(Math.abs(px.height - 80)).toBeLessThanOrEqual(1);

    const clamped = normalizedRectToPixelRect({ x: -0.5, y: 1.2, width: 2, height: 2 }, 500, 400);
    expect(clamped.x).toBeGreaterThanOrEqual(0);
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(500);
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(400);
  });

  it('支持自定义预设创建与 localStorage 增删改查及异常容错', () => {
    const custom = createCustomPresetFromRect('我的专属水印', {
      x: 0.75,
      y: 0.85,
      width: 0.2,
      height: 0.1,
    });
    expect(custom.isCustom).toBe(true);
    expect(custom.platform).toBe('custom');
    expect(custom.regions[0].anchor).toBe('bottom-right');

    const afterSave = saveCustomPreset(custom);
    expect(afterSave).toHaveLength(1);
    expect(loadCustomPresets()).toHaveLength(1);

    // 固定归一化框应精确映射至目标图像尺寸
    const rects = computePresetRects(custom, 1000, 500);
    expect(rects).toEqual([{ x: 750, y: 425, width: 200, height: 50 }]);

    const afterDelete = deleteCustomPreset(custom.id);
    expect(afterDelete).toHaveLength(0);
    expect(loadCustomPresets()).toHaveLength(0);

    // 损坏 JSON 或非法 region 字段时安全过滤，不产出 NaN
    localStorage.setItem('clearmark_custom_presets_v1', '{invalid-json');
    expect(loadCustomPresets()).toEqual([]);

    localStorage.setItem(
      'clearmark_custom_presets_v1',
      JSON.stringify([
        {
          id: 'bad-anchor',
          name: '非法锚点',
          platform: 'custom',
          regions: [{ anchor: 'invalid-corner', widthRatio: 0.2, heightRatio: 0.1 }],
        },
        {
          id: 'bad-ratio',
          name: '非法比例',
          platform: 'custom',
          regions: [{ anchor: 'bottom-right', widthRatio: -1, heightRatio: 0.1 }],
        },
        custom,
      ]),
    );
    const loaded = loadCustomPresets();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(custom.id);
  });
});
