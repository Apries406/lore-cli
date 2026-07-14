import { execFile } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import {
  DEFAULT_COLD_KNOWLEDGE_DAYS,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_DASHBOARD_WINDOW_DAYS,
} from "../domain/constants.js";
import { ErrorCode, ExitCode } from "../domain/enums.js";
import { LoreError } from "../errors.js";
import {
  DASHBOARD_CSS,
  DASHBOARD_HTML,
  DASHBOARD_JS,
} from "../dashboard/assets.js";
import { getDashboardSnapshot } from "./dashboard-service.js";
import { showWikiPage } from "./query-service.js";

const execFileAsync = promisify(execFile);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface DashboardServerOptions {
  host?: string;
  port?: number;
  window_days?: number;
  cold_after_days?: number;
}

export interface DashboardServerHandle {
  url: string;
  host: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

function positiveInteger(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, {
    "content-type": `${contentType}; charset=utf-8`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  response.end(body);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, "application/json", JSON.stringify(value));
}

/** 启动只绑定回环地址的本地 Dashboard。 */
export async function startDashboardServer(
  root: string,
  options: DashboardServerOptions = {},
): Promise<DashboardServerHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new LoreError(
      ErrorCode.InvalidArgument,
      `Dashboard 只允许监听本机回环地址：${host}`,
      ExitCode.InvalidArgument,
    );
  }
  const requestedPort = options.port ?? DEFAULT_DASHBOARD_PORT;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new LoreError(
      ErrorCode.InvalidArgument,
      `Dashboard 端口无效：${requestedPort}`,
      ExitCode.InvalidArgument,
    );
  }
  const defaultWindow = options.window_days ?? DEFAULT_DASHBOARD_WINDOW_DAYS;
  const defaultCold = options.cold_after_days ?? DEFAULT_COLD_KNOWLEDGE_DAYS;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET") {
        json(response, 405, { error: "method_not_allowed" });
        return;
      }
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (requestUrl.pathname === "/") {
        send(response, 200, "text/html", DASHBOARD_HTML);
        return;
      }
      if (requestUrl.pathname === "/app.css") {
        send(response, 200, "text/css", DASHBOARD_CSS);
        return;
      }
      if (requestUrl.pathname === "/app.js") {
        send(response, 200, "text/javascript", DASHBOARD_JS);
        return;
      }
      if (requestUrl.pathname === "/health") {
        json(response, 200, { ok: true });
        return;
      }
      if (requestUrl.pathname === "/api/dashboard") {
        json(
          response,
          200,
          await getDashboardSnapshot(root, {
            window_days: positiveInteger(requestUrl.searchParams.get("window"), defaultWindow),
            cold_after_days: positiveInteger(
              requestUrl.searchParams.get("cold"),
              defaultCold,
            ),
          }),
        );
        return;
      }
      if (requestUrl.pathname === "/api/wiki") {
        const pagePath = requestUrl.searchParams.get("path");
        if (!pagePath) {
          json(response, 400, { error: "missing_path" });
          return;
        }
        json(response, 200, await showWikiPage(root, pagePath));
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Dashboard 请求失败";
      json(response, 500, { error: "dashboard_error", message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const displayHost = host.includes(":") ? `[${host}]` : host;
  const url = `http://${displayHost}:${address.port}`;
  return {
    url,
    host,
    port: address.port,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** 使用系统默认浏览器打开本地 Dashboard。 */
export async function openDashboardInBrowser(url: string): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("open", [url]);
  } else if (process.platform === "win32") {
    await execFileAsync("cmd.exe", ["/c", "start", "", url]);
  } else {
    await execFileAsync("xdg-open", [url]);
  }
}
