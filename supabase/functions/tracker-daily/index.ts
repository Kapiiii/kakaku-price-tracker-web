import { dailyHandler } from "./handler.ts";
Deno.serve((req) => dailyHandler(req));
