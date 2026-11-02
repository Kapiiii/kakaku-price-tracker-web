import { createSupabaseContext } from "npm:@supabase/server@1.9.2";
import { dispatch } from "../tracker-api/handler.ts";
type Client = any;
async function makeAdmin() {
  const { data: ctx, error } = await createSupabaseContext(new Request("https://scheduler.invalid"), {
    auth: "none",
  });
  if (error || !ctx) throw new Error("Unable to initialize scheduler");
  return ctx.supabaseAdmin;
}
export async function dailyHandler(
  req: Request,
  getAdmin: () => Promise<Client> = makeAdmin,
  process = dispatch,
): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (req.method !== "POST") return Response.json({ error: "POST required" }, { status: 405, headers });
  const secret = req.headers.get("x-tracker-secret") ?? "";
  if (!req.headers.get("Authorization")?.startsWith("Bearer ")) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  if (req.headers.has("Origin") || !/^[a-f0-9]{64}$/.test(secret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  try {
    const reader = req.body?.getReader();
    let text = "", size = 0;
    if (!reader) return Response.json({ error: "Invalid request" }, { status: 400, headers });
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024) {
        await reader.cancel();
        return Response.json({ error: "Request too large" }, { status: 413, headers });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const body = JSON.parse(text), jobID = body.job_id;
    if (
      body.probe !== true &&
      (typeof jobID !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(jobID))
    ) return Response.json({ error: "Invalid job" }, { status: 400, headers });
    const admin = await getAdmin();
    const { data: target, error } = await admin.rpc("tracker_daily_target", {
      p_secret: secret,
      p_job: body.probe === true ? null : jobID,
    });
    if (error) throw new Error(error.message);
    if (!target?.authorized) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
    if (body.probe === true) return Response.json({ ok: true }, { headers });
    if (!target.job) return Response.json({ error: "Job not found" }, { status: 404, headers });
    const result = await process(admin, target.job.user_id, { action: "step", job_id: target.job.id });
    return Response.json({
      ok: true,
      busy: !!result.busy,
      status: result.job?.status ?? "running",
      done: result.job?.done ?? null,
    }, { headers });
  } catch (error) {
    console.error("Daily update failed:", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "Daily update will be retried" }, { status: 500, headers });
  }
}
