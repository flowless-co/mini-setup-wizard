export type InputItem = {
    category: "flow_meter" | "pressure_sensor" | "zone" | string;
    coords: any;
    label: string;
    inletFor?: string | null;
    outletFor?: string | null;
    metric_unit?: string | null;
    metric_interval?: string | null;
    metric_category?: string | null;
    metric_storage_table?: number | null;
    notes?: string | null;
    attribute?: any;
    tags_list?: any[] | null;
};
export type FixtureRow = {
    model: string;
    pk: string | number;
    fields: Record<string, any>;
};
export declare function buildFixture(input: unknown): FixtureRow[];
export declare function buildFixtureJson(input: unknown, indent?: number): string;
