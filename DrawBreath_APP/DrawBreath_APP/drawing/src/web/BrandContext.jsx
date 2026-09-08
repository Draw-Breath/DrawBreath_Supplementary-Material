import { createContext, useContext } from 'react';

const BrandContext = createContext({ displayName: 'Learning Platform' });

export function BrandProvider({ displayName, children }) {
  return <BrandContext.Provider value={{ displayName }}>{children}</BrandContext.Provider>;
}

export function useBrand() {
  return useContext(BrandContext);
}
