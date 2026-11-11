import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// 不使用 StrictMode：xterm 实例在 effect 外按标签常驻，开发模式的重复挂载会造成双重初始化
createRoot(document.getElementById('root')!).render(<App />);
