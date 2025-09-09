/* eslint-disable @typescript-eslint/no-explicit-any */
export type Coord = [number, number]; // [lon, lat]
export type Ring = Coord[]; // closed ring
export type Polygon = Ring[]; // polygon with outer ring (and holes if provided)

export type InputItem = {
  category: "zone" | "flow_meter" | "pressure_sensor" | string;
  label: string;
  coords: Coord | Polygon; // point or polygon
  inletFor?: string | null;
  outletFor?: string | null;
  // Optional metric hints coming from inputs
  metric_unit?: string | null;
  metric_interval?: string | null;
  metric_category?: string | null;
};

export type FixtureItem = {
  model: string;
  pk: string | number;
  fields: any;
};

export type BuildOptions = {
  // If true, only create flow_reading when metric_category is missing or explicitly flow_reading
  strictFlowReading?: boolean;
};
