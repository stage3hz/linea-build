/** Native contract of «Снег» on the phone (src/SnowPhone.tsx).
 *  The view (requireNativeViewManager('LineaSnow')) is ONE transparent, non-interactive surface mounted above the whole
 *  app. It draws falling snow, the snow caps lying on the «ledges» it is told about, the rime on frozen glass, the
 *  snow knocked or swept off and the meltwater drops. It never takes a touch: touches are only observed at window
 *  level (as in modules/linea-trail). The device's real thermal state melts the snow (see `setHeat`).
 *  The module (requireOptionalNativeModule('LineaSnow')) carries the calls below; all are fire-and-forget and safe to
 *  repeat. On any native failure nothing is drawn. All coordinates are in points / dp of the app window. */
export type SnowLedge = {
  /** Stable id: the drift of a ledge survives while its id is reported. */
  id: string;
  /** The ledge's rectangle in window coordinates. Snow lies on its top edge and follows the rounded corners. */
  x: number; y: number; width: number; height: number;
  /** Corner radius (a pill: height / 2). */
  radius: number;
  /** Tallest cap, pt (demo: 6 on bars, 4 on round buttons, 5 on the island, 7 on the tab bar). */
  max: number;
  /** 'glass': rime grows inward from its rim and a tap inside knocks the snow off. 'island': snow only, no rime, no knock. */
  kind: 'glass' | 'island';
};
export interface LineaSnowBridge {
  /** Start (true) or stop and clear (false): observing touches, the frame loop, the thermal listener. */
  setEnabled(enabled: boolean): void;
  /** The complete set of ledges on screen right now; replaces the previous set. Drifts are kept by id. */
  setLedges(ledges: SnowLedge[]): void;
  /** Dark theme (true) or light (false): the rime is white on dark glass, blue on light glass. */
  setDark(dark: boolean): void;
  /** Test override of the heat (0…1); a negative value returns to the device's real thermal state. */
  setHeat(heat: number): void;
  /** Android: the display cutout at the top of the window (camera hole / pill) as a rectangle, or null. iOS: null. */
  cutout(): { x: number; y: number; width: number; height: number } | null;
}
export type LineaSnowViewProps = {
  /** false: the view stops drawing and its frame loop sleeps. */
  active?: boolean;
};
