// Asking the user mid-reply. The server sends a `permission` SSE event, the UI shows the permission
// sheet and POSTs the answer to /api/permissions/:id. No answer (closed window, stopped reply,
// 5 minutes) counts as Deny.

export type PermissionRequest = {
  tool: string;
  path: string; // file path, URL or search query
  action: "read" | "send";
  reason?: string; // shown in the sheet, e.g. which secret was read earlier
};

const pending = new Map<string, (allow: boolean) => void>();
const TIMEOUT_MS = 5 * 60_000;

export async function ask(send: (event: string, data: unknown) => Promise<void>, req: PermissionRequest, signal: AbortSignal): Promise<boolean> {
  const id = crypto.randomUUID();
  const answer = new Promise<boolean>((resolve) => {
    const finish = (allow: boolean) => (pending.delete(id), clearTimeout(timer), resolve(allow));
    const timer = setTimeout(() => finish(false), TIMEOUT_MS);
    signal.addEventListener("abort", () => finish(false), { once: true });
    pending.set(id, finish);
  });
  await send("permission", { id, ...req });
  return answer;
}

export function answer(id: string, allow: boolean) {
  const finish = pending.get(id);
  finish?.(allow);
  return !!finish;
}

// Per-reply state the tools share: once a secret has been read, web requests need a yes too,
// so a prompt-injected page can't have the model send the secret out in a URL.
export type ToolContext = {
  ask(req: PermissionRequest): Promise<boolean>;
  secretRead: string | null; // path of the first secret read in this reply
};
