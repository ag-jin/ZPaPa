#!/usr/bin/env node
/**
 * zcode-board / Bash 源变更检测（B3-1，#101；纯函数、零 IO、零第三方依赖）
 *
 * 背景（E4-06 高 / AD-10③）：watch-sources 原先只认 PostToolUse(Write|Edit)，
 * Bash 通道的源变更完全在检测面外——
 *   1. 删除/移动源（归档正规路径 = git mv / rm）→ 板上节点滞留或悬空，双向无警报；
 *   2. 非 Write|Edit 新增源（cp / 解包 / git checkout 落下的计划稿）→ 板缺节点；
 *   3. Bash 写入源（sed -i / echo > 重定向 / tee 等不经 Write/Edit 的写入）→ 板内容陈旧。
 * 本模块把 Bash 命令文本解析为"源面变更宣称"（claim：op/verb/path/dest/dirCandidate），归属判定
 * （是否真相源、是否已知源）由调用方注入的谓词完成——watch-sources 据此输出
 * "板陈旧告警"并指向重编译；事件携带路径与目标，供 B3-2 分流挂点（删除源属归档
 * 移动 → 合法转移提示，指向 --assign 改写）使用。
 *
 * 边界（轻量启发，不是 shell 解释器；宁少报不误报，漏面由 Stop 兜底重编译补齐）：
 *   - 不解析 xargs / find -delete / bash -c 内的二级命令；不展开变量与命令替换；
 *   - heredoc 正文不参与解析（<<[-]DELIM 起至定界行）；
 *   - 通配参数由调用方按"首个通配段之前的前缀"做目录级归属（本模块原样透传路径串）。
 *
 * 无第三方依赖（仅 node 内置——本模块不 import 任何东西）。
 */

// ---------------------------------------------------------------- shell 词法（保守子集）

/** 去 heredoc 正文：<<[-]DELIM 起始行之后、定界行（含）之前的行不参与解析。 */
function stripHeredocBodies(cmd) {
  const lines = String(cmd).split("\n");
  const out = [];
  let pending = null;
  for (const line of lines) {
    if (pending !== null) {
      const probe = pending.dash ? line.replace(/^\t+/, "") : line;
      if (probe === pending.delim) pending = null;
      out.push("");
      continue;
    }
    out.push(line);
    for (const d of heredocDelimsOf(line)) pending = d; // 同一行多个 heredoc 取末个（罕见）
  }
  return out.join("\n");
}

function heredocDelimsOf(line) {
  const out = [];
  const toks = scan(line);
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.type === "op" && (t.value === "<<" || t.value === "<<-")) {
      const nxt = toks[i + 1];
      if (nxt && nxt.type === "word" && nxt.value !== "") out.push({ delim: nxt.value, dash: t.value === "<<-" });
    }
  }
  return out;
}

/**
 * shell 词法扫描（保守子集）：尊重单/双引号与反斜杠转义；操作符单独成 token；
 * 不做变量展开（`$X` 原样保留，后续归属判定自然不命中）。
 */
function scan(cmd) {
  const tokens = [];
  let cur = "";
  let started = false;
  let quote = null;
  const flush = () => {
    if (started) tokens.push({ type: "word", value: cur });
    cur = "";
    started = false;
  };
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && ch === "\\" && i + 1 < cmd.length && /[\\"$`]/.test(cmd[i + 1])) {
        cur += cmd[i + 1];
        i += 1;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < cmd.length) {
        cur += cmd[i + 1];
        started = true;
        i += 1;
      }
      continue;
    }
    if (ch === "\n" || ch === ";") {
      flush();
      tokens.push({ type: "op", value: ";" });
      continue;
    }
    if (ch === "&") {
      flush();
      if (cmd[i + 1] === "&") {
        tokens.push({ type: "op", value: "&&" });
        i += 1;
      } else tokens.push({ type: "op", value: "&" });
      continue;
    }
    if (ch === "|") {
      flush();
      if (cmd[i + 1] === "|") {
        tokens.push({ type: "op", value: "||" });
        i += 1;
      } else tokens.push({ type: "op", value: "|" });
      continue;
    }
    if (ch === ">" || ch === "<") {
      flush();
      let op = ch;
      if (cmd[i + 1] === ch) {
        op = ch + ch;
        i += 1;
        if (op === "<<") {
          if (cmd[i + 1] === "<") {
            op = "<<<"; // herestring：无正文
            i += 1;
          } else if (cmd[i + 1] === "-") {
            op = "<<-"; // 去缩进 heredoc
            i += 1;
          }
        }
      }
      tokens.push({ type: "op", value: op });
      continue;
    }
    if (ch === "(" || ch === ")") {
      flush();
      tokens.push({ type: "op", value: ch });
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    cur += ch;
    started = true;
  }
  flush();
  return tokens;
}

const SEGMENT_OPS = new Set([";", "&&", "||", "|", "&"]);

/** 按命令分隔符切段（重定向操作符留在段内，供目标提取）。 */
function segmentize(tokens) {
  const segs = [];
  let cur = [];
  for (const t of tokens) {
    if (t.type === "op" && SEGMENT_OPS.has(t.value)) {
      segs.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  segs.push(cur);
  return segs;
}

// ---------------------------------------------------------------- 命令解析（保守词法）

/** 前缀命令/环境赋值：剥掉后取真实动词（sudo/command/nohup/time/env + KEY=VAL）。 */
const PREFIX_COMMANDS = new Set(["sudo", "command", "nohup", "time", "env", "builtin"]);

function stripPrefixes(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (PREFIX_COMMANDS.has(w)) {
      i += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function basename(word) {
  const parts = String(word).split("/");
  return parts[parts.length - 1];
}

/** 词序列 → { verb, positionals, opts }；`--` 之后一律位置参数。 */
function parseVerb(words, valueOpts = new Set()) {
  const start = stripPrefixes(words);
  if (start >= words.length) return null;
  const verb = basename(words[start]);
  const rest = words.slice(start + 1);
  const positionals = [];
  const opts = new Set();
  let endOfOpts = false;
  for (let i = 0; i < rest.length; i += 1) {
    const w = rest[i];
    if (!endOfOpts && w === "--") {
      endOfOpts = true;
      continue;
    }
    if (!endOfOpts && w.startsWith("-") && w !== "-") {
      const optName = w.includes("=") ? w.slice(0, w.indexOf("=")) : w;
      opts.add(optName);
      if (!w.includes("=") && valueOpts.has(optName)) i += 1; // 选项值不是路径
      continue;
    }
    positionals.push(w);
  }
  return { verb, positionals, opts };
}

/** 删除类命令（worktree 级删除）。 */
const DELETE_VERBS = new Set(["rm", "rmdir", "unlink", "shred"]);

/** 复制类命令：末位是目标（文件或目录），其余为源（源侧只读，不立 claim）。 */
const COPY_VERBS = new Set(["cp", "install", "rsync"]);

/** 移动类命令：末位是目标，其余为源（源侧立 move claim，目标侧归属判定交给调用方）。 */
const MOVE_VERBS = new Set(["mv"]);

/** 写入类命令：全部位置参数均为写入目标。 */
const WRITE_VERBS = new Set(["touch", "tee"]);

/** 就地编辑命令（仅 -i/--in-place 生效时算写入；否则是过滤器，读文件到 stdout）。 */
const INPLACE_VERBS = new Set(["sed", "perl"]);

/** 各命令的"取值选项"（其后的词是选项值、不是路径）。 */
const VALUE_OPTS_BY_VERB = {
  cp: new Set(["-t", "--target-directory", "-S", "--suffix"]),
  mv: new Set(["-t", "--target-directory", "-S", "--suffix"]),
  install: new Set(["-t", "--target-directory", "-S", "--suffix", "-m", "--mode", "-o", "--owner", "-g", "--group"]),
  rsync: new Set(["-e", "--rsh", "--exclude", "--include", "--filter", "--files-from", "--rsync-path", "--chmod", "--port", "--timeout"]),
  sed: new Set(["-e", "--expression", "-f", "--file", "-l", "--line-length"]),
  perl: new Set(["-e", "-E", "-f", "-F", "-M", "-m", "-I"]),
};

function valueOptsFor(verb) {
  return VALUE_OPTS_BY_VERB[verb] ?? new Set();
}

/** -i/--in-place（含 -Ei、-pi 之类的短选项簇与 -i.bak 后缀形态）。 */
function hasInPlaceFlag(opts) {
  for (const o of opts) {
    if (o === "--in-place" || o.startsWith("--in-place=")) return true;
    if (o.length >= 2 && o.startsWith("-") && !o.startsWith("--") && o.slice(1).includes("i")) return true;
  }
  return false;
}

/** 重定向目标（>、>>；排除 2>&1 一类 fd 复制与 $ 展开的空目标）。 */
function redirectTargets(seg) {
  const out = [];
  for (let i = 0; i < seg.length; i += 1) {
    const t = seg[i];
    if (t.type === "op" && (t.value === ">" || t.value === ">>")) {
      const nxt = seg[i + 1];
      if (nxt && nxt.type === "word" && nxt.value !== "" && !nxt.value.startsWith("&") && !nxt.value.startsWith("$")) out.push(nxt.value);
    }
  }
  return out;
}

function posixJoin(dir, base) {
  const d = String(dir).replace(/\/+$/, "");
  return d === "" ? base : `${d}/${base}`;
}

function baseNameOf(p) {
  const parts = String(p).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1];
}

const GIT_GLOBAL_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/** git 子命令解析 → { sub, positionals, opts }；非 git 段返回 null。 */
function parseGit(words) {
  let i = stripPrefixes(words);
  if (i >= words.length || basename(words[i]) !== "git") return null;
  i += 1;
  while (i < words.length && words[i].startsWith("-")) {
    if (GIT_GLOBAL_VALUE_OPTS.has(words[i])) i += 1;
    i += 1;
  }
  if (i >= words.length) return null;
  const sub = words[i];
  const parsed = parseVerb(["git", ...words.slice(i + 1)], valueOptsFor(sub));
  if (parsed === null) return null;
  return { sub, positionals: parsed.positionals, opts: parsed.opts };
}

/** 段内动词预判（仅用于选"取值选项"表；完整解析交给 parseVerb）。 */
function verbOf(words) {
  const start = stripPrefixes(words);
  return start < words.length ? basename(words[start]) : "";
}

/**
 * Bash 命令文本 → 源面变更宣称（claim：{ op, verb, path, dest, dirCandidate }；未做归属判定）。
 * op 语义：
 *   delete —— path 从源面移除（rm/rmdir/unlink/shred；git rm）；
 *   write  —— path 内容被写/创建（重定向 / tee / touch / sed -i / cp 目标）；
 *   move   —— path → dest（mv / git mv；dest 为 null 表示移出项目根）。
 * write claim 的 dirCandidate 仅在"目标真是目录"时才应替代 path（调用方以 fs 判定）。
 */
export function scanSourceChangeClaims(command) {
  const text = stripHeredocBodies(String(command ?? ""));
  const claims = [];
  for (const seg of segmentize(scan(text))) {
    const words = seg.filter((t) => t.type === "word").map((t) => t.value);
    if (words.length === 0) continue;
    const git = parseGit(words);
    if (git !== null) {
      if (git.sub === "rm") {
        if (git.opts.has("--cached")) continue; // 仅索引，不动现场（编译器读文件系统）
        for (const p of git.positionals) claims.push({ op: "delete", verb: "git rm", path: p, dest: null });
      } else if (git.sub === "mv" && git.positionals.length >= 2) {
        const dest = git.positionals[git.positionals.length - 1];
        for (const p of git.positionals.slice(0, -1)) claims.push({ op: "move", verb: "git mv", path: p, dest });
      }
      continue;
    }
    const parsed = parseVerb(words, valueOptsFor(verbOf(words)));
    // 重定向目标与动词类型无关（printf/cat/echo/node 等都可能 > 源文件）。
    for (const t of redirectTargets(seg)) claims.push({ op: "write", verb: "redirect", path: t, dest: null });
    if (parsed === null) continue;
    const { verb, positionals } = parsed;
    if (DELETE_VERBS.has(verb)) {
      for (const p of positionals) claims.push({ op: "delete", verb, path: p, dest: null });
      continue;
    }
    if (COPY_VERBS.has(verb)) {
      // 末位为目标（文件或目录）；目录目标的展开候选 dirCandidate=<dest>/<basename(src)> 交调用方
      // 结合 fs 判定（目标真是目录才用候选——否则会造出 <文件>/<basename> 伪路径）。
      if (positionals.length >= 2) {
        const dest = positionals[positionals.length - 1];
        for (const src of positionals.slice(0, -1)) {
          if (src === "") continue;
          claims.push({ op: "write", verb, path: dest, dirCandidate: posixJoin(dest, baseNameOf(src)) });
        }
      }
      continue;
    }
    if (WRITE_VERBS.has(verb)) {
      for (const p of positionals) claims.push({ op: "write", verb, path: p, dirCandidate: null });
      continue;
    }
    if (MOVE_VERBS.has(verb) && positionals.length >= 2) {
      const dest = positionals[positionals.length - 1];
      for (const p of positionals.slice(0, -1)) claims.push({ op: "move", verb, path: p, dest });
      continue;
    }
    if (INPLACE_VERBS.has(verb) && hasInPlaceFlag(parsed.opts)) {
      for (const p of positionals) {
        if (p !== "") claims.push({ op: "write", verb, path: p, dest: null });
      }
    }
  }
  return claims;
}
