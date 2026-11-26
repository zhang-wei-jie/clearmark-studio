/**
 * Store 实例 Context 载体（单独文件以保持 Vite Fast Refresh 零警告）
 */

import { createContext } from 'react';
import type { AppStoreInstance } from './types';

export const StoreInstanceContext = createContext<AppStoreInstance | null>(null);
