import React, { useEffect, useRef } from 'react';
export function ScreenVideo({ stream }: { stream: any }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { const video = ref.current; if (!video) return; video.srcObject = stream; void video.play().catch(() => {}); return () => { video.srcObject = null; }; }, [stream]);
  return React.createElement('video', { ref, autoPlay: true, playsInline: true, muted: true, controls: true, style: { width: '100%', aspectRatio: '16 / 9', background: '#000', objectFit: 'contain' } });
}
