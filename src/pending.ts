import { randomUUID } from "node:crypto";

/**
 * prepare 가 만든 쓰기 계획을 commit 까지 잠시 보관한다. 토큰은 한 번만 쓸 수 있고 ttl 이 지나면 버린다 —
 * 오래된 미리보기로 저장하는 일을 막기 위해서다.
 */
export class PendingStore<T> {
  private readonly items = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  put(value: T): { token: string; expiresAt: Date } {
    this.sweep();
    const token = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    this.items.set(token, { value, expiresAt });
    return { token, expiresAt: new Date(expiresAt) };
  }

  take(token: string): T {
    const item = this.items.get(token);
    this.items.delete(token);
    if (!item) throw new Error("알 수 없거나 이미 사용한 토큰이다 — prepare 부터 다시 해야 한다");
    if (item.expiresAt < this.now()) throw new Error("토큰이 만료되었다 — prepare 부터 다시 해야 한다");
    return item.value;
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, v] of this.items) if (v.expiresAt < now) this.items.delete(k);
  }
}
