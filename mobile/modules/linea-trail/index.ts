/** Native bridge contract (src/PixelTrail.tsx loads it with requireOptionalNativeModule('LineaTrail')).
 *  Both calls are fire-and-forget and safe to repeat; on any native failure the module simply draws nothing. */
export interface LineaTrailBridge {
  /** Show the trail (true) or remove the overlay and stop observing touches (false). */
  setEnabled(enabled: boolean): void;
  /** Trail colour, '#RRGGBB' (white on dark themes, black on light ones). */
  setColor(color: string): void;
}
