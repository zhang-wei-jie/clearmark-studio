/**
 * 零新增依赖的 React 19 + jsdom 轻量组件测试工具
 *
 * 封装 React.act 与 react-dom/client createRoot，避免引入额外第三方测试框架依赖，
 * 同时提供统一的 DOM 渲染、点击、键盘事件与浏览器 Blob URL / Image 测试桩。
 */

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// 启用 React 19 act 测试环境标记，避免 jsdom 下输出 act 环境告警
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 为 jsdom 补齐缺失的 ResizeObserver，确保 CanvasWorkspace 等依赖尺寸观察的组件可正常挂载
if (typeof globalThis.ResizeObserver === 'undefined') {
  class MockResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
    MockResizeObserver;
}

/** 显式安装可恢复的 Canvas 2D getContext 桩，避免模块顶层永久覆写原型污染其他单测 */
export function installMockCanvasContext(): () => void {
  if (typeof HTMLCanvasElement === 'undefined') {
    return () => undefined;
  }
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;
  return () => {
    HTMLCanvasElement.prototype.getContext = original;
  };
}

export interface RenderedView {
  container: HTMLDivElement;
  rerender: (next: ReactElement) => void;
  unmount: () => void;
}

const mountedViews = new Set<RenderedView>();

/** 在独立 DOM 容器中同步渲染 React 组件树 */
export function renderView(element: ReactElement): RenderedView {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(element);
  });

  const view: RenderedView = {
    container,
    rerender(next) {
      act(() => {
        root.render(next);
      });
    },
    unmount() {
      if (!mountedViews.has(view)) return;
      mountedViews.delete(view);
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };

  mountedViews.add(view);
  return view;
}

/** 清理本轮用例挂载的全部 React 根节点 */
export function cleanupViews(): void {
  for (const view of Array.from(mountedViews)) {
    view.unmount();
  }
}

/** 在 React act 作用域中触发元素点击并刷新微任务 */
export async function clickElement(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

/** 在 React act 作用域中向指定目标派发事件并等待微任务收敛 */
export async function dispatchEventAsync(target: EventTarget, event: Event): Promise<void> {
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });
}

export interface MockBlobUrlTracker {
  createdUrls: string[];
  revokedUrls: string[];
  restore: () => void;
}

/** 为 jsdom 补齐并追踪 URL.createObjectURL / URL.revokeObjectURL 调用 */
export function installBlobUrlTracker(): MockBlobUrlTracker {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  let seq = 1;

  URL.createObjectURL = (() => {
    const url = `blob:clearmark-test-${seq++}`;
    createdUrls.push(url);
    return url;
  }) as typeof URL.createObjectURL;

  URL.revokeObjectURL = ((url: string) => {
    revokedUrls.push(url);
  }) as typeof URL.revokeObjectURL;

  return {
    createdUrls,
    revokedUrls,
    restore() {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };
}
