// Minimal types — adjust to your project types if you have them
type Fixture = { model: string; fields: any };

export function findMetric(
  items: Fixture[],
  category: string,
  targetId?: string
): string | undefined {
  const hit = items.find(
    (x) =>
      x.model === "fl_monitoring.metricdefinition" && // <- was fl_monitoring.metric
      x.fields?.category === category &&
      (!targetId || x.fields?.target_id === targetId)
  );
  return hit?.fields?.id;
}
