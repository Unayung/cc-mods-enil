// 在 daemon 那台機器上跑的小程式（node -e），mod 透過它跟 enil daemon 講話。
//
// mod 的環境沒有 socket，只能起行程，所以每個請求起一次 `node -e BRIDGE req`：
// 從 stdin 讀一行 JSON，轉給 unix socket，把第一行回應印出來就結束。daemon 在別台
// （omarchy）時前面加 ssh。推送用 `sub` 模式常駐。
//
// 這段原始碼會被單引號包起來交給遠端的 shell，所以裡面不能有單引號。

export const BRIDGE = String.raw`
const net = require("net"), fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const S = process.env.ENIL_STATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "enil");
const [mode, ...args] = process.argv.slice(1);
const at = (p) => (path.isAbsolute(p) ? p : path.join(S, p));
const input = () => { try { return fs.readFileSync(0); } catch { return Buffer.alloc(0); } };
const out = (s) => process.stdout.write(s, () => process.exit(0));

if (mode === "info") {
  out(JSON.stringify({ stateDir: S, home: os.homedir(), sock: fs.existsSync(path.join(S, "sock")) }));
} else if (mode === "req") {
  const line = input().toString("utf8").trim() + "\n";
  const sock = net.connect(path.join(S, "sock"));
  let buf = "";
  sock.setTimeout(55000, () => { out(JSON.stringify({ ok: false, error: "daemon 沒有回應" })); });
  sock.on("connect", () => sock.write(line));
  sock.on("data", (d) => {
    buf += d;
    const nl = buf.indexOf("\n");
    if (nl >= 0) { sock.destroy(); out(buf.slice(0, nl)); }
  });
  sock.on("error", () => out(JSON.stringify({ ok: false, error: "daemon 沒在跑", offline: true })));
} else if (mode === "sub") {
  const sock = net.connect(path.join(S, "sock"));
  sock.on("connect", () => sock.write(JSON.stringify({ cmd: "subscribe" }) + "\n"));
  sock.on("data", (d) => process.stdout.write(d));
  sock.on("error", () => process.exit(2));
  sock.on("close", () => process.exit(1));
  process.stdin.on("end", () => process.exit(0));
} else if (mode === "read") {
  let text = "";
  try { text = fs.readFileSync(at(args[0]), "utf8"); } catch {}
  out(text);
} else if (mode === "stat") {
  let st = null;
  try { const s = fs.statSync(at(args[0])); st = { size: s.size, mtime: s.mtimeMs }; } catch {}
  out(JSON.stringify(st));
} else if (mode === "write") {
  const file = at(args[0]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", input());
  fs.renameSync(file + ".tmp", file);
  out("ok");
} else if (mode === "put") {
  const dir = path.join(S, "uploads");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, path.basename(args[0] || "file"));
  fs.writeFileSync(file, input(), { mode: 0o600 });
  out(file);
} else if (mode === "cat") {
  fs.createReadStream(at(args[0])).on("error", () => process.exit(1)).pipe(process.stdout);
} else if (mode === "png") {
  // [[路徑, 最大邊長], ...] → { "路徑@邊長": base64 PNG | null }。[0] 取第一格（APNG、GIF）。
  const want = JSON.parse(input().toString("utf8") || "[]");
  const res = {};
  for (const [p, size] of want) {
    const key = p + "@" + size;
    try {
      const png = cp.execFileSync("magick", [at(p) + "[0]", "-auto-orient", "-resize", size + "x" + size + ">", "-strip", "-define", "png:compression-level=9", "png:-"], { maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"], timeout: 20000 });
      res[key] = png.toString("base64");
    } catch { res[key] = null; }
  }
  out(JSON.stringify(res));
} else {
  out(JSON.stringify({ ok: false, error: "bridge: 不認得的模式 " + mode }));
}
`
