/** TaskManager's /hooks/gateway door. */
import { SandboxError } from "@panth977/sandbox/server/node";
import type { Live, Tm } from "./app.ts";

export function tmClient(baseUrl: string, secret: string): Tm {
  const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
  const base = baseUrl.replace(/\/$/, "");
  return {
    async live(id) {
      const r = await fetch(`${base}/hooks/gateway/artifacts/${id}`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`TaskManager answered ${r.status}`);
      return (await r.json()) as Live;
    },
    async host(id, op, input) {
      const r = await fetch(`${base}/hooks/gateway/artifacts/${id}/host`, { method: "POST", headers, body: JSON.stringify({ op, input }), signal: AbortSignal.timeout(25_000) });
      if (!r.ok) throw new SandboxError("unavailable", `TaskManager answered ${r.status}`);
      const v = (await r.json()) as { ok: boolean; value?: unknown; code?: string; message?: string };
      if (!v.ok) throw new SandboxError(v.code ?? "internal", v.message ?? "failed");
      return v.value ?? null;
    },
  };
}
