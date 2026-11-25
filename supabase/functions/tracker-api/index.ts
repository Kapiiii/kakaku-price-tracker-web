import { handler } from "./handler.ts";
const developmentOrigin = Deno.env.get("TRACKER_DEVELOPMENT_ORIGIN") ?? "";
Deno.serve((req) => handler(req, undefined, developmentOrigin));
