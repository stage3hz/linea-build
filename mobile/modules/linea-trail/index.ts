/** Native contract of «Пиксельный след» (src/PixelTrail.tsx).
 *  The module (requireOptionalNativeModule('LineaTrail')) switches the effect and sets the theme colour; both calls
 *  are fire-and-forget and safe to repeat. The view (requireNativeViewManager('LineaTrail')) is the drawing surface
 *  placed in the app's background layers: it never takes touches and draws the part of the one shared light that
 *  falls on it. On any native failure nothing is drawn. */
export interface LineaTrailBridge {
  /** Observe touches and light the mounted views (true), or stop and clear (false). */
  setEnabled(enabled: boolean): void;
  /** Default tile colour, '#RRGGBB' (white on dark themes, black on light ones). */
  setColor(color: string): void;
}
export type LineaTrailViewProps = {
  /** Tile colour of this view, '#RRGGBB'; without it the module's colour is used. */
  color?: string;
  /** false: the view stops drawing (a screen kept mounted under another one). */
  active?: boolean;
};
