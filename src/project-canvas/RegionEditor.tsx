import { useRef, useState } from 'react';
import type { Region } from './types';

export default function RegionEditor({ src, value, onChange, readOnly = false }: { src: string; value: Region | null; onChange?: (region: Region | null) => void; readOnly?: boolean }) {
  const image = useRef<HTMLImageElement>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const point = (event: React.PointerEvent) => {
    const rect = image.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  return <div className={`board-region ${readOnly ? 'readonly' : ''}`} data-testid="region-editor"
    onPointerDown={(event) => { if (readOnly || !image.current || event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); setStart(point(event)); onChange?.(null); }}
    onPointerMove={(event) => { if (!start) return; const end = point(event); const width = Math.abs(end.x - start.x), height = Math.abs(end.y - start.y); if (width > 0.002 && height > 0.002) onChange?.({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width, height }); }}
    onPointerUp={() => setStart(null)} onPointerCancel={() => setStart(null)}>
    <img ref={image} src={src} alt="参考图，拖动以圈选要参考的区域" draggable={false} />
    {value ? <div className="board-region-box" data-testid="region-box" style={{ left: `${value.x * 100}%`, top: `${value.y * 100}%`, width: `${value.width * 100}%`, height: `${value.height * 100}%` }} /> : null}
  </div>;
}
