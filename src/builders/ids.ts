export class IdRegistry {
  private used = new Set<string>();
  private seq = 1;

  /** prefix id like m-xxxxxx, t-xxxxxx, pl-xxxxxx, p-xxxxxx */
  make(prefix: string): string {
    let id = "";
    do {
      const rand = Math.random().toString(36).slice(2, 10);
      id = `${prefix}-${rand}${this.seq.toString(36)}`;
      this.seq += 1;
    } while (this.used.has(id));
    this.used.add(id);
    return id;
  }

  /** numeric incremental for models that expect integer PK (links) */
  makeInt(): number {
    // Still keep unique constraint via Set as string key
    let n = this.seq++;
    while (this.used.has(String(n))) n = this.seq++;
    this.used.add(String(n));
    return n;
  }

  /** pseudo GUID for calc_args.metric_id, not used as PK */
  guid(): string {
    const part = () => Math.random().toString(16).slice(2, 10);
    return `${part()}-${part()}-${part()}-${part()}`;
  }
}
