/** Loopback archive adapter. Remote signing and write methods are refused. */
import http from "node:http";
import { ResearchPolicy } from './acquisition-policy.mjs';
const upstream =
  process.env.RESEARCH_ARCHIVE_URL || process.env.RESEARCH_RPC_URL || "";
if (!upstream) throw new Error("RESEARCH_ARCHIVE_URL or RESEARCH_RPC_URL is required");
const policy = new ResearchPolicy([upstream]);
const allowed = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getProof",
  "eth_call",
  "eth_getLogs",
  "eth_gasPrice",
  "eth_feeHistory",
  "alchemy_getAssetTransfers",
  "web3_clientVersion",
  "net_version",
]);

let socket;
let ready;
let nextId = 1;
const pending = new Map();
let active = 0;
const waiters = [];

function connect() {
  socket = new WebSocket(upstream);
  ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const decoded = JSON.parse(String(event.data));
    for (const response of Array.isArray(decoded) ? decoded : [decoded]) {
      const item = pending.get(response.id);
      if (!item) continue;
      pending.delete(response.id);
      clearTimeout(item.timer);
      item.resolve({ ...response, id: item.originalId });
    }
  });
  socket.addEventListener("close", () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("archive connection closed"));
    }
    pending.clear();
    socket = undefined;
    ready = undefined;
  });
  return ready;
}

async function acquire() {
  if (active >= 10) await new Promise((resolve) => waiters.push(resolve));
  active += 1;
}

function release() {
  active -= 1;
  waiters.shift()?.();
}

async function wsCall(request) {
  await acquire();
  try {
    policy.beforeSend(upstream, 1);
    await (ready || connect());
    const id = nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("archive request timed out"));
      }, 30_000);
      pending.set(id, { resolve, reject, timer, originalId: request.id });
      socket.send(JSON.stringify({ ...request, id }));
    });
  } finally {
    release();
  }
}

const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2_000_000) {
      res.writeHead(413);
      res.end();
      return;
    }
  }
  try {
    const value = JSON.parse(body);
    const rows = Array.isArray(value) ? value : [value];
    if (!rows.length || rows.some((q) => !allowed.has(q.method))) {
      res.writeHead(403);
      res.end("read-only archive");
      return;
    }
    if (/^wss?:/.test(upstream)) {
      let response = await Promise.all(rows.map(wsCall));
      if (req.headers["x-research-timestamps"] === "1") {
        response = response.map((row) => ({
          ...row,
          result: Array.isArray(row.result)
            ? row.result.map(({ blockNumber, blockHash, blockTimestamp }) => ({
                blockNumber,
                blockHash,
                blockTimestamp,
              }))
            : row.result?.transfers
              ? {
                  transfers: row.result.transfers.map(
                    ({ blockNum, metadata }) => ({ blockNum, metadata }),
                  ),
                  pageKey: row.result.pageKey,
                }
              : row.result?.number
                ? {
                    number: row.result.number,
                    hash: row.result.hash,
                    timestamp: row.result.timestamp,
                    baseFeePerGas: row.result.baseFeePerGas,
                  }
              : row.result,
        }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(value) ? response : response[0]));
    } else {
      policy.beforeSend(upstream, rows.length);
      const response = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(30000),
      });
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(await response.text());
    }
  } catch {
    res.writeHead(502);
    res.end("archive read failed");
  }
});
server.listen(16875, "127.0.0.1", async () => {
  if (/^wss?:/.test(upstream)) await connect();
  console.log("Read-only archive ready");
});
