/** Starts the gateway. systemd restarts it if sandboxd goes away (infra/worker). */
import http from "node:http";
import { createSandbox } from "@panth977/sandbox/server/node";
import { createGateway } from "./app.ts";
import { tmClient } from "./tm.ts";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

const sandbox = createSandbox({ endpoint: process.env.SANDBOXD ?? "unix:///run/sandboxd.sock" });
const secret = need("TM_GATEWAY_SECRET");
const gateway = createGateway({ sandbox, secret, tm: tmClient(need("TM_URL"), secret) });
const port = Number(process.env.PORT ?? 8080);
http.createServer((req, res) => void gateway.handle(req, res)).listen(port, process.env.HOST ?? "127.0.0.1", () => console.log(`gateway on ${port}`));

setInterval(() => {
  sandbox.list().catch((e) => {
    console.error("sandboxd is gone:", e);
    process.exit(1);
  });
}, 15_000);
