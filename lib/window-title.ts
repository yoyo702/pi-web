/**
 * The browser tab title. Approvals waiting in any workspace come first because
 * they block work; otherwise the unread notification count.
 */
export function windowTitle({ cwdName, approvals, unread }: { cwdName: string | null; approvals: number; unread: number }): string {
  const base = cwdName ? `${cwdName} - TianForge pi` : "TianForge pi";
  if (approvals > 0) return `(${approvals} waiting) ${base}`;
  if (unread > 0) return `(${unread}) ${base}`;
  return base;
}
