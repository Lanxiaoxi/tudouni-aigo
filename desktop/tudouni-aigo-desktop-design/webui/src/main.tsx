import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// 样式装配顺序有意义：字体 → token → 全局 → 组件 → 外壳 → 流
import '@/styles/fonts.css';
import '@/styles/tokens.css';
import '@/styles/global.css';
import '@/styles/components.css';
import '@/styles/app.css';
import '@/styles/stream.css';

import { App } from './App';

const host = document.getElementById('root');
if (!host) throw new Error('#root not found');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
