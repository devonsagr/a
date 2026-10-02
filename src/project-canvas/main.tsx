import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/jetbrains-mono/index.css';
import BoardApp from './BoardApp';
createRoot(document.getElementById('root')!).render(<StrictMode><BoardApp /></StrictMode>);
