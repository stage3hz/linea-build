import React, { createContext, useContext } from 'react';

const RenderActive = createContext(true);

/** Kept-mounted screens remain visible during navigation, but stop decorative rendering. */
export function RenderActivity({ active, children }: { active: boolean; children: React.ReactNode }) {
  const parentActive = useContext(RenderActive);
  return <RenderActive.Provider value={parentActive && active}>{children}</RenderActive.Provider>;
}

export const useRenderActive = () => useContext(RenderActive);
