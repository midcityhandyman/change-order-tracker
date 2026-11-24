import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.ts";
import { seed } from "./seed.ts";
import { Tracker, TrackerError } from "./tracker.ts";

const PAGE = fileURLToPath(new URL("../public/index.html", import.meta.url));

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 100_000) throw new TrackerError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new TrackerError(400, "request body must be a JSON object");
  }
}

export function createApp(tracker: Tracker): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const route = `${method} ${url.pathname}`;
      let m: RegExpMatchArray | null;

      if (route === "GET /" || route === "GET /index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(PAGE));
      } else if (route === "GET /api/projects") {
        send(res, 200, tracker.listProjects());
      } else if ((m = route.match(/^GET \/api\/projects\/(\d+)$/))) {
        send(res, 200, tracker.getProject(Number(m[1])));
      } else if ((m = route.match(/^POST \/api\/projects\/(\d+)\/change-orders$/))) {
        send(res, 201, tracker.requestChangeOrder(Number(m[1]), await readJson(req)));
      } else if ((m = route.match(/^GET \/api\/change-orders\/(\d+)$/))) {
        send(res, 200, tracker.getChangeOrder(Number(m[1])));
      } else if ((m = route.match(/^POST \/api\/change-orders\/(\d+)\/price$/))) {
        send(res, 200, tracker.priceChangeOrder(Number(m[1]), await readJson(req)));
      } else if ((m = route.match(/^POST \/api\/change-orders\/(\d+)\/(approve|decline)$/))) {
        const decision = m[2] === "approve" ? "approved" : "declined";
        const ctx = { ip: req.socket.remoteAddress, userAgent: req.headers["user-agent"] };
        send(res, 200, tracker.decide(Number(m[1]), decision, await readJson(req), ctx));
      } else if (route === "GET /api/audit") {
        const projectId = url.searchParams.get("projectId");
        if (projectId !== null && !/^\d+$/.test(projectId)) throw new TrackerError(400, "projectId must be a whole number");
        send(res, 200, tracker.listAudit(projectId === null ? undefined : Number(projectId)));
      } else if (route === "GET /api/audit/verify") {
        send(res, 200, tracker.verifyAudit());
      } else {
        send(res, 404, { error: "not found" });
      }
    } catch (err) {
      if (err instanceof TrackerError) send(res, err.status, { error: err.message });
      else {
        console.error(err);
        send(res, 500, { error: "internal error" });
      }
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tracker = new Tracker(openDb(process.env.DB_PATH || ":memory:"));
  seed(tracker);
  const port = Number(process.env.PORT || 3000);
  createApp(tracker).listen(port, "127.0.0.1", () => {
    console.log(`change-order-tracker listening on http://localhost:${port}`);
  });
}
