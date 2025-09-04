type Fixture = { model: string; pk?: number; fields?: { id?: number } };

export function makeIntAllocator(items: Fixture[], model: string) {
  const existing = items
    .filter((x) => x.model === model)
    .map((x) => Number(x.fields?.id ?? x.pk ?? 0))
    .filter(Number.isFinite);

  let next = (existing.length ? Math.max(...existing) : 0) + 1;
  return () => next++;
}
