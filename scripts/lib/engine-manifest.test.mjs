// manifest 完整性单测：数据声明是安装器与状态查询的共同输入，形态错误要在测试层爆而不是装到一半爆。
import test from "node:test";
import assert from "node:assert/strict";
import { ENGINES, ENGINE_IDS, sayLabRoot, engineDir, UV_INDEX } from "./engine-manifest.mjs";

test("四引擎全注册且 id 一致", () => {
  assert.deepEqual(ENGINE_IDS.sort(), ["firered", "gptsovits", "indextts", "voxcpm"]);
  for (const [id, m] of Object.entries(ENGINES)) assert.equal(m.id, id);
});

test("每个引擎声明仓库、Python 版本与至少一步依赖安装", () => {
  for (const m of Object.values(ENGINES)) {
    assert.match(m.repo, /^https:\/\/github\.com\//, `${m.id} repo`);
    assert.match(m.python, /^3\.\d+$/, `${m.id} python`);
    assert.ok(m.deps.steps.length > 0, `${m.id} deps.steps`);
    for (const s of m.deps.steps) assert.equal(s.cmd[0], "uv", `${m.id} 依赖命令走 uv`);
  }
});

const KNOWN_NETS = new Set(["modelscope", "hf-mirror", "github", "jsdelivr"]);

test("每个主权重带精确 size、64 位 sha256 与合法通道声明（ModelScope 居首当存在）", () => {
  for (const m of Object.values(ENGINES)) {
    for (const w of m.weights) {
      if (w.tier === "auto") continue; // 自拉依赖不做硬校验（远端 size 漂移属正常）
      assert.ok(Number.isInteger(w.size) && w.size > 0, `${m.id}/${w.file} size`);
      assert.match(w.sha256, /^[0-9a-f]{64}$/, `${m.id}/${w.file} sha256 形态`);
      assert.ok(w.sources.length >= 1, `${m.id}/${w.file} 至少一条通道`);
      // ModelScope aria2 直连实测最快：存在则必居首；部分资产源在 HF Spaces / GitHub examples，
      // 上游无 ModelScope 仓直链形态，单通道或 github/jsdelivr 组合合法（voice_01/prompt_2 先例）
      const msIndex = w.sources.findIndex((s) => s.net === "modelscope");
      if (msIndex >= 0) {
        assert.equal(msIndex, 0, `${m.id}/${w.file} ModelScope 居首`);
        assert.ok(w.sources[0].url.includes("modelscope.cn/models/"), `${m.id}/${w.file} MS URL 形态`);
      }
      for (const s of w.sources) {
        assert.ok(KNOWN_NETS.has(s.net), `${m.id}/${w.file} 通道 net=${s.net} 在白名单`);
        assert.match(s.url, /^https:\/\//, `${m.id}/${w.file} ${s.net} URL 形态`);
      }
    }
  }
});

test("auto 层自拉件锚引擎权威消费位：路径形态与可选指纹合法", () => {
  for (const m of Object.values(ENGINES)) {
    for (const w of m.weights) {
      if (w.tier !== "auto") continue;
      assert.ok(Number.isInteger(w.size) && w.size > 0, `${m.id}/${w.file} size`);
      // 给了指纹就必须完整（install 侧 sizeMatches 依赖精确 size 防下载中断残留误判就绪）
      if (w.sha256 !== "") assert.match(w.sha256, /^[0-9a-f]{64}$/, `${m.id}/${w.file} sha256 形态`);
      assert.ok(w.sources.length >= 1, `${m.id}/${w.file} 至少一条通道`);
      for (const s of w.sources) assert.ok(KNOWN_NETS.has(s.net), `${m.id}/${w.file} 通道 net=${s.net}`);
      assert.ok(!/\/(facebook|nvidia)\//.test(w.file), `${m.id}/${w.file} 不得按 HF hub cache 布局带 org 前缀（引擎消费位是平铺 hf_cache/<name>）`);
    }
  }
});

test("gptsovits 清单含英文路径 NLTK 三件（fresh 面隐藏依赖，缺件回退 system 掩盖为出声）", () => {
  const files = ENGINES.gptsovits.weights.map((w) => w.file);
  for (const need of [
    "venv/nltk_data/tokenizers/punkt_tab",
    "venv/nltk_data/taggers/averaged_perceptron_tagger_eng",
    "venv/nltk_data/corpora/cmudict",
  ]) {
    assert.ok(files.includes(need), `缺 NLTK 件 ${need}`);
  }
  // 落位锚 venv 内：NLTK 自动查 sys.prefix/nltk_data，数据随 venv 生命周期自包含（HOME 散落不可复现）
  for (const f of files.filter((f) => f.includes("nltk_data"))) assert.ok(f.startsWith("venv/"), `${f} 应落 venv/ 内`);
});

test("firered 恰有 4 处机械 patch 且 replace 与 find 不同", () => {
  assert.equal(ENGINES.firered.patches.length, 4);
  for (const p of ENGINES.firered.patches) {
    assert.ok(p.find && p.replace && p.find !== p.replace, `${p.file} patch 条目形态`);
    assert.ok(p.file.startsWith("fireredtts3/"), "patch 只触引擎源码树");
  }
  const devices = ENGINES.firered.patches.filter((p) => p.find.includes("torch.device('cuda')"));
  assert.equal(devices.length, 2, "两处设备行（Base/Instruct）");
  for (const d of devices) assert.ok(d.replace.includes("FIRERED_DEVICE"), "设备行经 env 参数化");
  const attn = ENGINES.firered.patches.filter((p) => p.find.includes("flash_attention_2"));
  assert.equal(attn.length, 2, "两处 attn（redae 构造 + config 字典）");
  for (const a of attn) assert.equal(a.replace.includes("sdpa"), true, "attn 换 sdpa");
});

test("sayLabRoot 走 XDG_DATA_HOME 覆盖，空串视同未设", () => {
  assert.equal(sayLabRoot({ HOME: "/h", XDG_DATA_HOME: "" }), "/h/.local/share/say-lab");
  assert.equal(sayLabRoot({ HOME: "/h", XDG_DATA_HOME: "/data" }), "/data/say-lab");
  assert.equal(sayLabRoot({ XDG_DATA_HOME: "/data" }), "/data/say-lab");
  assert.equal(engineDir("voxcpm", { XDG_DATA_HOME: "/data" }), "/data/say-lab/voxcpm");
});

test("UV_INDEX 是国内镜像（直连 PyPI 挂死，报告实证）", () => {
  assert.ok(UV_INDEX.includes("tsinghua") || UV_INDEX.includes("aliyun"), UV_INDEX);
});
