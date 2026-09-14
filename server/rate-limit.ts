export class ActionBudget {
  private timestamps: number[] = [];
  count(now: number): number {
    this.timestamps = this.timestamps.filter(t => now - t < 60000);
    return this.timestamps.length;
  }
  take(count: number, now: number, limit: number): boolean {
    if (this.count(now) + count > limit) return false;
    this.timestamps.push(...Array<number>(count).fill(now));
    return true;
  }
  // Emergency cancellation is never delayed by the normal quote budget.
  recordCancellation(count: number, now: number): void {
    this.count(now);
    this.timestamps.push(...Array<number>(count).fill(now));
  }
}
