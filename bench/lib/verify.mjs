// --verify：证据链对账，跑分硬性契约的机器执行面。只读，不调用任何引擎。
// 设计红线（针对「虚构报告 + 空 wav 自检通过」的造假失败模式）：存在性 ≠ 有效性——
// 样本判数据字节与 afinfo 时长，报告判全格中位数复算比对（report 内嵌 JSON 块），
// 矩阵规模由 EXPECTED_CHANNELS 钉死不随注册面缩水；N/A（通道级/格子级）必须有失败行或退化输出佐证。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { KOKORO_DIR, MATCHA_DIR, MLX_TTS_ENTRY, QWEN3_DIR, SHERPA_BIN, ZIPVOICE_DIR } from "./assets.mjs";
import { ALL_CHANNELS, EXPECTED_CHANNELS } from "./channels.mjs";
import { DEGENERATE_RATIO, MIN_SAMPLE_DATA_BYTES, REPORT, RUNS, SAMPLES, TEXT_IDS } from "./config.mjs";
import { runCmd } from "./exec.mjs";
import { readLog } from "./log.mjs";
import { afinfoDurationS, checkSample } from "./sample.mjs";
import { aggregateCells } from "./verdict.mjs";

/**
 * @typedef {{name: string, status: "PASS"|"FAIL", detail: string}} Check
 */

/** 解析 report 内嵌 bench-cells 块；报告或块缺失/损坏返回 null，由 C3 报 FAIL */
function parseReportBlock() {
  if (!existsSync(REPORT)) return null;
  const md = readFileSync(REPORT, "utf-8");
  const m = md.match(/```json bench-cells\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export async function verify() {
  /** @type {Check[]} */
  const checks = [];
  const log = readLog();
  const synth = log.filter((l) => l.phase === "synth");

  // 通道级 N/A 凭 runner 可用性失败行（phase=install, exit≠0, textid=null, channel 非空）判定，
  // 并带时序撤销：append-only 日志下取每通道最后一个状态行，失败行之后出现 synth 行即视为已恢复、不再豁免——
  // 否则历史一次失败会永久放行该通道后续缺口；资产落地的 install 行（channel=null）属 setup 面，不参与通道判定
  const lastState = new Map();
  log.forEach((l) => {
    if (l.channel == null) return;
    const key = `${l.engine}|${l.channel}`;
    if (l.phase === "install" && l.exit !== 0 && l.textid == null) lastState.set(key, "fail");
    else if (l.phase === "synth") lastState.set(key, "synth");
  });
  const unavailable = new Set([...lastState].filter(([, s]) => s === "fail").map(([k]) => k));
  const registered = new Set(ALL_CHANNELS.map((c) => `${c.engine}|${c.channel}`));

  // 格子级 N/A：report bench-cells 块的 na_cells 声明（如单语言模型对外语文本产出退化空音频），
  // 每格必须有真实尝试行佐证（见 C5），声明本身不产生豁免效力
  const block = parseReportBlock();
  const naCells = new Set((block?.na_cells ?? []).map((n) => `${n.engine}|${n.channel}|${n.textid}`));

  // C0 矩阵注册完备：注册面缩水 = 自检放水，必须 FAIL
  const missing = EXPECTED_CHANNELS.filter((c) => !registered.has(`${c.engine}|${c.channel}`));
  checks.push({
    name: "C0-矩阵注册完备",
    status: missing.length === 0 ? "PASS" : "FAIL",
    detail: missing.length === 0 ? `${EXPECTED_CHANNELS.length} 通道全注册` : `未注册通道: ${missing.map((c) => `${c.engine}/${c.channel}`).join(", ")}`,
  });

  // C1 格子覆盖：每格 exit=0 行数 ≥ RUNS；通道级 N/A 与格子级 N/A 豁免
  const c1Fail = [];
  for (const c of EXPECTED_CHANNELS) {
    const key = `${c.engine}|${c.channel}`;
    if (unavailable.has(key)) continue;
    for (const textid of TEXT_IDS) {
      if (naCells.has(`${key}|${textid}`)) continue;
      for (const mode of ["cold", "hot"]) {
        const n = synth.filter((r) => r.engine === c.engine && r.channel === c.channel && r.textid === textid && r.mode === mode && r.exit === 0).length;
        if (n < RUNS) c1Fail.push(`${c.engine}/${c.channel}/${textid}/${mode}: ${n}/${RUNS}`);
      }
    }
  }
  checks.push({
    name: "C1-格子覆盖",
    status: c1Fail.length === 0 ? "PASS" : "FAIL",
    detail: c1Fail.length === 0 ? `全部应测格 ≥${RUNS} 次成功合成（N/A 通道 ${unavailable.size} 个、N/A 格 ${naCells.size} 个豁免）` : `缺口 ${c1Fail.length} 格: ${c1Fail.slice(0, 12).join("; ")}${c1Fail.length > 12 ? " …" : ""}`,
  });

  // say 对照基线：退化判定的分母（对照通道必然在跑；基线缺失时退化检查自然跳过，
  // 而 say 自身样本缺失已被 C2 绝对下限判罚，不存在「毁基线放行退化」的逃逸面）
  const sayBaseline = new Map();
  for (const textid of TEXT_IDS) {
    sayBaseline.set(textid, await afinfoDurationS(path.join(SAMPLES, `system-say-spawn-${textid}.wav`)));
  }

  // C2 样本有效性：数据字节 ≥22050 且 afinfo 时长 >0.5s——44B 空 wav 必须 FAIL；
  // 绝对下限之上叠加退化判定——时长 < say 对照 25% 的「非 N/A 格」必须 FAIL（退化却不声明 = 拿噪声冒充可用语音）
  const c2Fail = [];
  let c2Checked = 0;
  for (const c of EXPECTED_CHANNELS) {
    const key = `${c.engine}|${c.channel}`;
    if (unavailable.has(key)) continue;
    for (const textid of TEXT_IDS) {
      if (naCells.has(`${key}|${textid}`)) continue;
      const file = path.join(SAMPLES, `${c.engine}-${c.channel}-${textid}.wav`);
      const r = await checkSample(file);
      c2Checked++;
      if (!r.ok) {
        c2Fail.push(`${path.basename(file)}: ${r.reasons.join("+")}`);
        continue;
      }
      const base = sayBaseline.get(textid);
      if (base != null && r.durationS < base * DEGENERATE_RATIO) {
        c2Fail.push(`${path.basename(file)}: 退化音频 ${r.durationS.toFixed(2)}s < ${DEGENERATE_RATIO}×say对照 ${base.toFixed(2)}s（应声明 N/A）`);
      }
    }
  }
  checks.push({
    name: "C2-样本有效性",
    status: c2Fail.length === 0 ? "PASS" : "FAIL",
    detail: c2Fail.length === 0 ? `${c2Checked} 个样本全部通过字节+时长双检` : `${c2Fail.length}/${c2Checked} 不合格: ${c2Fail.slice(0, 8).join("; ")}${c2Fail.length > 8 ? " …" : ""}`,
  });

  // C3 报告对账：report 内嵌 JSON 块的每格中位数必须与 raw-log 重算一致（全格，非抽样）
  const recomputed = aggregateCells(synth);
  checks.push(checkReport(recomputed, block, naCells));

  // C4 存在性证据：二进制/入口/模型目录在盘 + report 附录引用一致
  checks.push(await checkExistence());

  // C5 N/A 诚实性：通道级凭带 stderr 的失败行；格子级凭真实尝试行（失败行或退化输出行）
  const c5Fail = [];
  for (const key of unavailable) {
    const [engine] = key.split("|");
    const evidence = log.filter((l) => l.engine === engine && l.exit !== 0 && l.exit !== null && (l.stderr_tail ?? "").length > 0);
    if (evidence.length === 0) c5Fail.push(`${engine}: N/A 但无带 stderr 的失败行`);
  }
  for (const key of naCells) {
    const [engine, channel, textid] = key.split("|");
    const rows = log.filter((l) => l.phase === "synth" && l.engine === engine && l.channel === channel && l.textid === textid);
    if (rows.length === 0) {
      c5Fail.push(`${key}: 声明 N/A 但无任何合成尝试行（未尝试即豁免 = 虚构）`);
      continue;
    }
    let backed = rows.some((l) => (l.exit !== 0 && (l.stderr_tail ?? "").length > 0) || (l.exit === 0 && (l.out_bytes ?? 0) < MIN_SAMPLE_DATA_BYTES));
    if (!backed) {
      // 字节下限挡不住的退化形态（长文本出零点几秒噪声但体积超下限）：对原始输出做 say 对照时长比判定
      const base = sayBaseline.get(textid);
      if (base != null) {
        for (const l of rows) {
          if (l.exit !== 0 || !l.out_file || !existsSync(l.out_file)) continue;
          const d = await afinfoDurationS(l.out_file);
          if (d != null && d < base * DEGENERATE_RATIO) {
            backed = true;
            break;
          }
        }
      }
    }
    if (!backed) c5Fail.push(`${key}: 声明 N/A 但无失败行或退化输出行佐证`);
  }
  checks.push({
    name: "C5-NA诚实性",
    status: c5Fail.length === 0 ? "PASS" : "FAIL",
    detail: unavailable.size + naCells.size === 0 ? "无 N/A 通道或格子" : c5Fail.length === 0 ? `${unavailable.size} 个 N/A 通道、${naCells.size} 个 N/A 格均有留证` : c5Fail.join("; "),
  });

  const ok = checks.every((c) => c.status === "PASS");
  return { ok, checks, cells: recomputed.length, unavailable: [...unavailable], naCells: [...naCells] };
}

/**
 * 报告对账三向：报告格 → log 重算一致；log 有效格 → 报告收录（N/A 格豁免）；N/A 声明 → 不得同时出现在 cells。
 * @param {Array} recomputed aggregateCells 重算结果
 * @param {object|null} block report 内嵌 JSON 块
 * @param {Set<string>} naCells
 * @returns {Check}
 */
function checkReport(recomputed, block, naCells) {
  if (!existsSync(REPORT)) {
    return { name: "C3-报告对账", status: "FAIL", detail: `report.md 不存在（${REPORT}）` };
  }
  if (!block) {
    return { name: "C3-报告对账", status: "FAIL", detail: "report.md 缺 bench-cells JSON 块或解析失败（对账锚点）" };
  }
  const actual = new Map(recomputed.map((c) => [`${c.engine}|${c.channel}|${c.textid}|${c.mode}`, c]));
  const diffs = [];
  for (const rc of block.cells ?? []) {
    const key = `${rc.engine}|${rc.channel}|${rc.textid}|${rc.mode}`;
    if (naCells.has(`${rc.engine}|${rc.channel}|${rc.textid}`)) {
      diffs.push(`${key}: 已声明 N/A 却出现在 cells（矛盾声明）`);
      continue;
    }
    const a = actual.get(key);
    if (!a) { diffs.push(`${key}: log 无对应成功行（报告数字无出处=虚构）`); continue; }
    if (Math.round(a.median_ms) !== Math.round(rc.median_ms)) diffs.push(`${key}: 报告 ${rc.median_ms} ≠ log 重算 ${a.median_ms}`);
    if (a.verdict !== rc.verdict) diffs.push(`${key}: 报告判定 ${rc.verdict} ≠ 重算 ${a.verdict}`);
  }
  // 反向：log 有而报告缺 = 漏报；N/A 格的退化数据行不参与聚合对账
  const reported = new Set((block.cells ?? []).map((rc) => `${rc.engine}|${rc.channel}|${rc.textid}|${rc.mode}`));
  for (const [key, cell] of actual) {
    if (naCells.has(`${cell.engine}|${cell.channel}|${cell.textid}`)) continue;
    if (!reported.has(key)) diffs.push(`${key}: log 有数据但报告未收录`);
  }
  return {
    name: "C3-报告对账",
    status: diffs.length === 0 ? "PASS" : "FAIL",
    detail: diffs.length === 0 ? `${reported.size} 格中位数与判定全部可由 raw-log 复现（N/A 格 ${naCells.size} 个按声明豁免收录）` : diffs.slice(0, 10).join("; "),
  };
}

async function checkExistence() {
  const problems = [];
  // sherpa 二进制 + --version 实输出：该 binary 无 --version 选项（exit≠0 打 usage 与 Invalid option 行），
  // 存在性证据的诚实口径 = 报告原样收录实输出锚行，而非要求 exit 0；版本号以发布 tag/包名佐证
  if (existsSync(SHERPA_BIN)) {
    const v = await runCmd([SHERPA_BIN, "--version"], { timeoutMs: 30_000 });
    const verOut = `${v.stdout}\n${v.stderrTail}`.trim();
    const lines = verOut.split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines.length === 0) {
      problems.push(`sherpa --version 无任何输出（二进制不可执行或损坏）: ${SHERPA_BIN}`);
    } else if (existsSync(REPORT)) {
      const anchor = lines.find((l) => /\d+\.\d+\.\d+/.test(l)) ?? lines.find((l) => l.includes("Invalid option")) ?? lines[lines.length - 1];
      if (!readFileSync(REPORT, "utf-8").includes(anchor)) {
        problems.push(`report 未收录 sherpa --version 实输出锚行（${anchor}）`);
      }
    }
  } else {
    problems.push(`sherpa 二进制不存在: ${SHERPA_BIN}（若下载失败须在 report 标 N/A）`);
  }
  // 模型目录非空
  for (const [label, dir] of [["kokoro", KOKORO_DIR], ["matcha", MATCHA_DIR], ["zipvoice", ZIPVOICE_DIR], ["qwen3", QWEN3_DIR]]) {
    if (!existsSync(dir) || readdirSync(dir).length === 0) problems.push(`${label} 模型目录缺失或为空: ${dir}`);
  }
  // mlx-audio 安装证据：tool 清单 + 控制台入口在盘
  const uvList = await runCmd(["uv", "tool", "list"], { timeoutMs: 60_000 });
  if (uvList.exit !== 0 || !/mlx-audio/.test(uvList.stdout)) problems.push("uv tool list 未见 mlx-audio");
  if (!existsSync(MLX_TTS_ENTRY)) problems.push(`mlx-audio TTS 入口不存在: ${MLX_TTS_ENTRY}`);
  return {
    name: "C4-存在性证据",
    status: problems.length === 0 ? "PASS" : "FAIL",
    detail: problems.length === 0 ? "sherpa 二进制/三模型目录/Qwen3 目录/mlx-audio 安装与入口全在盘" : problems.join("; "),
  };
}
