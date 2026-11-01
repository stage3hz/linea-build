import React, { useEffect, useRef } from 'react';
const streams = new Map<string, globalThis.MediaStream>();
function register(stream: globalThis.MediaStream): any { streams.set(stream.id, stream); (stream as any).toURL = () => stream.id; return stream; }
export class MediaStream extends globalThis.MediaStream { toURL() { register(this); return this.id; } }
export class RTCPeerConnection extends globalThis.RTCPeerConnection {
  private audio = new Map<string, HTMLAudioElement>();
  constructor(config?: RTCConfiguration) {
    super(config);
    this.addEventListener('track', event => {
      event.streams.forEach(register);
      if (event.track.kind === 'audio') {
        const audio = document.createElement('audio'); audio.srcObject = new globalThis.MediaStream([event.track]); audio.autoplay = true;
        this.audio.set(event.track.id, audio); void audio.play().catch(() => {});
      }
    });
  }
  close() { this.audio.forEach(audio => { audio.pause(); audio.srcObject = null; }); this.audio.clear(); super.close(); }
}
export const RTCSessionDescription = globalThis.RTCSessionDescription;
export const mediaDevices = {
  getUserMedia: async (constraints: MediaStreamConstraints) => register(await navigator.mediaDevices.getUserMedia(constraints)),
  getDisplayMedia: async (constraints: DisplayMediaStreamOptions) => register(await navigator.mediaDevices.getDisplayMedia(constraints)),
  enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
};
export function RTCView({ streamURL, style, objectFit = 'contain' }: any) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { const video = ref.current; if (!video) return; video.srcObject = streams.get(streamURL) || null; void video.play().catch(() => {}); return () => { video.srcObject = null; }; }, [streamURL]);
  return React.createElement('video', { ref, muted: true, autoPlay: true, playsInline: true, style: { ...style, objectFit, width: '100%', height: '100%' } });
}
export function registerGlobals() {}
