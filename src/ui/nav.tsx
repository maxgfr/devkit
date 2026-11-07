import { createContext, useContext } from "react";
import type { Route } from "../lib/panels";

/** Lets a panel open another one. The side panel provides it; elsewhere (DevTools) it is null. */
export const NavContext = createContext<((route: Route) => void) | null>(null);

export const useNav = () => useContext(NavContext);
