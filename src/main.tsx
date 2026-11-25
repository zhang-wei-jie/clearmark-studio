import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('未找到 #root 挂载节点，无法启动净影去水印工作台');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
