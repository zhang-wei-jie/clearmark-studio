import { describe, expect, it } from 'vitest';
import { buildExportFilename, deduplicateFilename } from '../export';

describe('导出文件名构建工具 (export)', () => {
  it('按目标格式拼接后缀与正确扩展名', () => {
    expect(
      buildExportFilename('赛博霓虹夜景_即梦AI.png', {
        format: 'png',
        quality: 0.92,
        filenameSuffix: '_clean',
        stripMetadata: true,
      }),
    ).toBe('赛博霓虹夜景_即梦AI_clean.png');

    expect(
      buildExportFilename('photo.heic', {
        format: 'jpeg',
        quality: 0.9,
        filenameSuffix: '_无水印',
        stripMetadata: true,
      }),
    ).toBe('photo_无水印.jpg');

    expect(
      buildExportFilename('artwork.webp', {
        format: 'webp',
        quality: 0.85,
        filenameSuffix: '',
        stripMetadata: true,
      }),
    ).toBe('artwork.webp');
  });

  it('过滤非法文件名字符并兜底空名称', () => {
    expect(
      buildExportFilename('dir/bad:name*?.png', {
        format: 'png',
        quality: 1,
        filenameSuffix: '_clean',
        stripMetadata: true,
      }),
    ).toBe('dir_bad_name___clean.png');

    expect(
      buildExportFilename('   ', {
        format: 'png',
        quality: 1,
        filenameSuffix: '_clean',
        stripMetadata: true,
      }),
    ).toBe('image_clean.png');
  });

  it('批量重名文件自动追加递增序号且保留扩展名', () => {
    const used = new Set<string>();
    expect(deduplicateFilename('photo_clean.png', used)).toBe('photo_clean.png');
    expect(deduplicateFilename('photo_clean.png', used)).toBe('photo_clean_2.png');
    expect(deduplicateFilename('photo_clean.png', used)).toBe('photo_clean_3.png');
  });
});
