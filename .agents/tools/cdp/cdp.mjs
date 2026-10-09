// 极简 CDP 客户端：用 WebSocket 驱动 dev 渲染进程
// 用法: node cdp.mjs <wsUrl> <expression> [--json]
import { createRequire } from "node:module";
const require = createRequire(process.env.ZPAPA_ROOT + "/package.json");
const { WebSocket } = require("ws");

const [, , WS, EXPR] = process.argv;
if (!WS || !EXPR) {
  console.error("用法: node cdp.mjs <wsUrl> <expr>");
  process.exit(2);
}

const ws = new WebSocket(WS, { perMessageDeflate: false });
let id = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
  else p.resolve(msg.result);
});

ws.on("open", async () => {
  try {
    const r = await send("Runtime.evaluate", {
      expression: EXPR,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      console.log(
        "JS 异常: " +
          JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(
            0,
            500,
          ),
      );
    } else {
      console.log(JSON.stringify(r.result?.value ?? null, null, 1));
    }
  } catch (e) {
    console.log("ERR: " + e.message);
  } finally {
    ws.close();
    setTimeout(() => process.exit(0), 50);
  }
});
ws.on("error", (e) => {
  console.log("WS ERR: " + e.message);
  process.exit(1);
});
