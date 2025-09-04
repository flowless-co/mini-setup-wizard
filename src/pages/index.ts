/* eslint-disable @typescript-eslint/no-explicit-any */

import { leakOverview } from "./leakOverview";

// Keep shapes minimal to avoid TS errors
export type PageSelection = {
  leakOverview: boolean;
};

export function applyPages(
  out: any[], // your fixture array
  ids: any, // IdRegistry
  pages: PageSelection
) {
  if (pages.leakOverview) {
    leakOverview(out, ids);
  }
}
