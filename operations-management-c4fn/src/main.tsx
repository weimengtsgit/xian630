import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
// 部署后叠加的深色战术风格覆盖（线上 18016 dist 里有，源码原本没有）。
// 必须在 index.css / App.css 之后 import，:root 变量覆盖才生效。
import './app-store-overrides.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
