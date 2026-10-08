import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { FIRERED_WEIGHT_MARKERS, GPTSOVITS_WEIGHT_MARKERS, INDEXTTS_WEIGHT_MARKERS, VOXCPM_WEIGHT_MARKERS, weightsFingerprint } from "../src/engines/daemon-session.ts";
import { ENGINES } from "../scripts/lib/engine-manifest.mjs";

/**
 * 权重指纹的跨语言公式一致性测试（daemon 版本握手的承重墙）。
 * TS 侧 weightsFingerprint 与 Python shim（scripts/shims/<engine>-shim.py --print-fingerprint）
 * 必须对同一磁盘投影产出同一摘要——公式漂移的爆炸半径是「每次握手失败 → 永远降级 per-call」，
 * 功能退化但不报错，极难在真机上归因，故在单测层用同一 fixture 双实现直接对拍。
 * 期望值另以独立来源（worked-example sha256）锚定，防两侧同错自我循环验证。
 */

const SHIM = fileURLToPath(new URL("../scripts/shims/gptsovits-shim.py", import.meta.url));
const INDEXTTS_SHIM = fileURLToPath(new URL("../scripts/shims/indextts-shim.py", import.meta.url));
const FIRERED_SHIM = fileURLToPath(new URL("../scripts/shims/firered-shim.py", import.meta.url));
const VOXCPM_SHIM = fileURLToPath(new URL("../scripts/shims/voxcpm-shim.py", import.meta.url));

/** 在临时 lab 根下落一个 marker 文件（size 字节 + 整毫秒 mtime），指纹投影的输入构造。
 * utimes 传秒（浮点可精确表示 1600000000.001 级），落盘 ns 取整后两侧 //1e6 均还原同一毫秒 */
function makeMarker(root: string, rel: string, size: number, mtimeMs: number): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "x".repeat(size));
  utimesSync(p, 0, mtimeMs / 1000);
}

function withTempLab(run: (root: string) => void): void {
  const root = join(tmpdir(), `say-fp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("weightsFingerprint 规范串（rel|size|mtime_ms 逐行升序 join 的 sha256）", () => {
  it("空清单 = sha256(空串)（worked-example 独立锚定）", () => {
    withTempLab((root) => {
      expect(weightsFingerprint(root, [])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });
  });

  it("单 marker 的规范串摘要对齐外部算出的锚定值", () => {
    withTempLab((root) => {
      makeMarker(root, "models/.install-ok", 5, 1600000000000);
      // 锚定值来源：对 "models/.install-ok|5|1600000000000" 独立执行 sha256（非本实现复算）。
      // fixture 一律取整秒时间戳：utimes 的 double 秒在非整 ms 处有 ±百 ns 抖动，
      // 落盘 ns 两侧 floor 到同一毫秒仅当输入本身是整秒（1600000000.0 可被 double 精确表示）
      expect(weightsFingerprint(root, ["models/.install-ok"])).toBe(
        "8bcf93f7de9c81de48e9842dae0a05c2f47ad26ff939c7352225773fd141e0be",
      );
    });
  });

  it("缺项 marker 投影为 rel|missing|0，锚定值对齐", () => {
    withTempLab((root) => {
      expect(weightsFingerprint(root, ["venv/nltk_data/corpora/cmudict/.install-ok"])).toBe(
        "77ff9c518b1b0204d7542d7a6d1679bc63ebfb7d5e6b3cb158736f3526ff0927",
      );
    });
  });

  it("多 marker 按 rel 升序 join（传入序与磁盘落点序不影响摘要）", () => {
    withTempLab((root) => {
      makeMarker(root, "z/.install-ok", 1, 1600000000000);
      makeMarker(root, "a/.install-ok", 10, 1600000001000);
      expect(weightsFingerprint(root, ["z/.install-ok", "a/.install-ok"])).toBe(
        "8eefb6bdce9ced702ad04adb281f59aab986aab5f1e19c521669ff1f9e88ae75",
      );
    });
  });

  it("mtime 变化即摘要变化（升级重装 marker → 旧 daemon 握手失效的机制锚）", () => {
    withTempLab((root) => {
      makeMarker(root, "a/.install-ok", 10, 1600000000002);
      const before = weightsFingerprint(root, ["a/.install-ok"]);
      makeMarker(root, "a/.install-ok", 10, 1600000000999);
      expect(weightsFingerprint(root, ["a/.install-ok"])).not.toBe(before);
    });
  });
});

describe("TS 与 Python shim 的指纹公式对拍（同一 fixture 双实现）", () => {
  it("六件套全在位时两侧摘要一致", () => {
    withTempLab((root) => {
      const stamp = 1600000000000;
      for (const rel of GPTSOVITS_WEIGHT_MARKERS) makeMarker(root, rel, 0, stamp);
      const ts = weightsFingerprint(root, GPTSOVITS_WEIGHT_MARKERS);
      const py = execFileSync("python3", [SHIM, "--print-fingerprint", "--repo", join(root, "GPT-SoVITS")], {
        encoding: "utf8",
      }).trim();
      expect(py).toBe(ts);
    });
  });

  it("部分 marker 缺席（missing 投影分支）两侧一致", () => {
    withTempLab((root) => {
      const [first, ...rest] = GPTSOVITS_WEIGHT_MARKERS;
      if (first !== undefined) makeMarker(root, first, 4, 1700000000000);
      for (const rel of rest.slice(0, 2)) makeMarker(root, rel, 8, 1700000001000);
      const ts = weightsFingerprint(root, GPTSOVITS_WEIGHT_MARKERS);
      const py = execFileSync("python3", [SHIM, "--print-fingerprint", "--repo", join(root, "GPT-SoVITS")], {
        encoding: "utf8",
      }).trim();
      expect(py).toBe(ts);
    });
  });
});

describe("voxcpm 的 TS 与 Python shim 指纹对拍（S5：同公式、per-engine 投影清单）", () => {
  it("七件套全在位时两侧摘要一致", () => {
    withTempLab((root) => {
      const stamp = 1600000000000;
      for (const rel of VOXCPM_WEIGHT_MARKERS) makeMarker(root, rel, 0, stamp);
      const ts = weightsFingerprint(root, VOXCPM_WEIGHT_MARKERS);
      const py = execFileSync("python3", [VOXCPM_SHIM, "--print-fingerprint", "--models", join(root, "models")], {
        encoding: "utf8",
      }).trim();
      expect(py).toBe(ts);
    });
  });

  it("部分 marker 缺席（missing 投影分支）两侧一致", () => {
    withTempLab((root) => {
      const [first, ...rest] = VOXCPM_WEIGHT_MARKERS;
      if (first !== undefined) makeMarker(root, first, 4, 1700000000000);
      for (const rel of rest.slice(0, 2)) makeMarker(root, rel, 8, 1700000001000);
      const ts = weightsFingerprint(root, VOXCPM_WEIGHT_MARKERS);
      const py = execFileSync("python3", [VOXCPM_SHIM, "--print-fingerprint", "--models", join(root, "models")], {
        encoding: "utf8",
      }).trim();
      expect(py).toBe(ts);
    });
  });
});

describe("firered 的 TS 与 Python shim 指纹对拍（S5：同公式、per-engine 投影清单）", () => {
  it("十一件套全在位时两侧摘要一致", () => {
    withTempLab((root) => {
      const stamp = 1600000000000;
      for (const rel of FIRERED_WEIGHT_MARKERS) makeMarker(root, rel, 0, stamp);
      const ts = weightsFingerprint(root, FIRERED_WEIGHT_MARKERS);
      const py = execFileSync("python3", [FIRERED_SHIM, "--print-fingerprint", "--repo", join(root, "FireRedTTS3")], {
        encoding: "utf8",
      }).trim();
      expect(py).toBe(ts);
    });
  });

  it("部分 marker 缺席（missing 投影分支）两侧一致", () => {
    withTempLab((root) => {
      const [first, ...rest] = FIRERED_WEIGHT_MARKERS;
      if (first !== undefined) makeMarker(root, first, 4, 1700000000000);
      for (const rel of rest.slice(0, 3)) makeMarker(root, rel, 8, 1700000001000);
      const ts = weightsFingerprint(root, FIRERED_WEIGHT_MARKERS);
      const py = execFileSync("python3", [FIRERED_SHIM, "--print-fingerprint", "--repo", join(root, "FireRedTTS3")], {
        encoding: "utf8",
      }).trim();
      expect(py).toBe(ts);
    });
  });
});

describe("indextts 的 TS 与 Python shim 指纹对拍（S3：同公式、per-engine 投影清单）", () => {
  it("十件套全在位时两侧摘要一致", () => {
    withTempLab((root) => {
      const stamp = 1600000000000;
      for (const rel of INDEXTTS_WEIGHT_MARKERS) makeMarker(root, rel, 0, stamp);
      const ts = weightsFingerprint(root, INDEXTTS_WEIGHT_MARKERS);
      const py = execFileSync("python3", [INDEXTTS_SHIM, "--print-fingerprint", "--repo", join(root, "index-tts")], {
        encoding: "utf8",
      }).trim();
      expect(py).toBe(ts);
    });
  });

  it("部分 marker 缺席（missing 投影分支）两侧一致", () => {
    withTempLab((root) => {
      const [first, ...rest] = INDEXTTS_WEIGHT_MARKERS;
      if (first !== undefined) makeMarker(root, first, 4, 1700000000000);
      for (const rel of rest.slice(0, 3)) makeMarker(root, rel, 8, 1700000001000);
      const ts = weightsFingerprint(root, INDEXTTS_WEIGHT_MARKERS);
      const py = execFileSync("python3", [INDEXTTS_SHIM, "--print-fingerprint", "--repo", join(root, "index-tts")], {
        encoding: "utf8",
      }).trim();
      expect(py).toBe(ts);
    });
  });
});

describe("marker 清单与安装 manifest 对拍（权重面单源，防 manifest 单侧扩容静默漂移）", () => {
  /**
   * marker 清单是权重指纹的输入，其真源在 engine-manifest.mjs 的 weights：归档条目安装成功写
   * `<file>/.install-ok` marker，文件级条目直接用 file 路径；auto 层是引擎首跑自拉的运行时产物、
   * 非安装事件，不进指纹（见 daemon-session.ts 各数组注释）。install-engine.mjs 的 ensureWeight
   * 逐文件幂等（sizeMatches 命中即 verified-existing，不重写 mtime），manifest 单侧扩容不会重装
   * 既有权重、指纹字节不变，运行中的旧 daemon 握手照旧通过、继续用旧权重集服务，静默漂移。
   * 故此处把两侧钉成同一清单：manifest 增删而未同步 marker 数组即测试红。
   */
  const expectedMarkers = (engine: string): string[] =>
    ENGINES[engine]!.weights
      .filter((w) => w.tier !== "auto")
      .map((w) => (w.archive !== undefined ? `${w.file}/.install-ok` : w.file));

  const cases: ReadonlyArray<[string, readonly string[]]> = [
    ["gptsovits", GPTSOVITS_WEIGHT_MARKERS],
    ["indextts", INDEXTTS_WEIGHT_MARKERS],
    ["firered", FIRERED_WEIGHT_MARKERS],
    ["voxcpm", VOXCPM_WEIGHT_MARKERS],
  ];

  for (const [engine, markers] of cases) {
    it(`${engine}：marker 清单 = manifest weights（归档取 .install-ok、排除 auto 层）逐条一致`, () => {
      expect([...markers].sort()).toEqual(expectedMarkers(engine).sort());
    });
  }
});
