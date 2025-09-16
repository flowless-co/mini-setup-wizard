// src/types.ts
export type Coord = [number, number]; // [lon, lat]
export type Ring = Coord[];
export type Polygon = Ring[];

export type FixtureItem = {
  model:
    | "fl_monitoring.polygon"
    | "fl_monitoring.point"
    | "fl_monitoring.link"
    | "fl_monitoring.metricdefinition"
    | "fl_dispatcher.metrictrigger"
    | "fl_page_settings.chart"
    | "fl_page_settings.card"
    | "fl_page_settings.pagesettings"
    | "fl_page_settings.map";
  pk: string | number;
  fields?: Record<string, any>;
};

export type ExtraMetricKind = "battery" | "signal" | "status";

export type ExtraMetricConfig = {
  kind: ExtraMetricKind;
  /** Optional override, sensible defaults per kind */
  unit?: string;
  /** Optional override, defaults to HOURLY */
  interval?: string;
  /** Optional label override */
  label?: string;
  /** Optional tags; defaults to ["raw_data"] */
  tags?: string[];
};

export type AuthorV2 =
  | {
      type: "flowMeterWithReading";
      label: string;
      unit: string; // e.g. "m³"
      interval: string; // e.g. "QUARTER_HOUR"
      coords: [number, number];
      extras?: ExtraMetricConfig[];
    }
  | {
      type: "flowMeterWithVolume";
      label: string;
      unit: string; // e.g. "m³"
      interval: string;
      coords: [number, number];
      extras?: ExtraMetricConfig[];
    }
  | {
      type: "flowMeterWithRate";
      label: string;
      unit: string; // e.g. "m³/h"
      interval: string;
      coords: [number, number];
      extras?: ExtraMetricConfig[];
    }
  | {
      type: "pressureSensor";
      label: string;
      unit: string; // e.g. "bar"
      interval: string; // e.g. "QUARTER_HOUR"
      coords: [number, number];
      extras?: ExtraMetricConfig[];
    }
  | {
      type: "zone";
      label: string;
      coords: any; // polygon; parsed in builder
      metricAbstractionId?: string[]; // e.g. ["MetricCategory.zoneDemand","MetricCategory.azp"]
      inlets?: string[]; // e.g. ["$flowMeterWithReading.M1","$flowMeterWithVolume.M2"]
      azpSensors?: string[]; // e.g. ["$pressureSensor.PS-1"]
      cppSensor?: string; // e.g. "$pressureSensor.PS-CPP"
      constants?: Record<string, number>;
    };
