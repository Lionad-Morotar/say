import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CHECKPOINTS, ENGINE, SHIMS_DIR, VENV_PYTHON, runShimPerCall } from "./indextts-say-lab.ts";

/**
 * indextts 冷启动瘦身的加载面测试（热启动 S4）：fastload patch（meta 建模 + to_empty +
 * torch.load(mmap)）与 missing-keys 全覆盖闸的行为钉死。
 *
 * 三层：
 * - toy 引擎微测（venv 探活门控）：以 types.ModuleType 复刻引擎加载语义的最小替身，
 *   验闸逻辑本体（三个静默面 + 天然 strict 面 + mmap 注入与回落 + 不适用保护）。
 *   替身复刻的是「行为契约」（strict=False 吞 missing、shape 过滤填旧值、'module.' 前缀剥离），
 *   期望值来自票 01 与验收口径的独立锚定，非实现复算。
 * - stub 层（无条件）：系统 python3（无 torch）下 patch 必须整体 no-op——
 *   S3 的 fake stub 引擎套件依赖这一保护。
 * - 集成红测（venv + 真实引擎代码门控）：空权重 gpt.pth → shim per-call 出 fatal 帧
 *   且 stderr 有 fastload 自报行（取证锚点规范：被测运行时自报，非外部期望）。
 *
 * 性能计时（ready ≤12s）不进套件——负载敏感断言必 flaky，走 docs/debug 真机取证轮。
 */

/** 探活与共享原语在 ./indextts-say-lab.ts（收集期一次性，多套件复用） */
const VENV = VENV_PYTHON !== null;

function makeTempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** venv python 写 torch fixture（save 语义与引擎消费面对齐） */
function pyWrite(root: string, code: string): void {
  const f = join(root, "fixture_writer.py");
  writeFileSync(f, code);
  execFileSync(VENV_PYTHON as string, [f], { timeout: 120_000, stdio: "pipe", env: { ...process.env, FIXTURE_ROOT: root } });
}

// ── toy 引擎 fixture：复刻 infer_v2_5 的运行时属性面与加载语义（非实现细节） ──
const TOY_ENGINE_PY = [
  "import types",
  "import torch",
  "import torch.nn as nn",
  "",
  "class UnifiedVoice(nn.Module):",
  "    def __init__(self, layers=2, model_dim=8, **kw):",
  "        super().__init__()",
  "        self.blocks = nn.ModuleList([nn.Linear(model_dim, model_dim) for _ in range(layers)])",
  "        self.out = nn.Linear(model_dim, 4)",
  "",
  "class MyModel(nn.Module):",
  "    def __init__(self, cfg):",
  "        super().__init__()",
  "        self.models = nn.ModuleDict({'cfm': nn.Linear(4, 4), 'length_regulator': nn.Linear(4, 4)})",
  "",
  "class CAMPPlus(nn.Module):",
  "    def __init__(self, feat_dim=80, embedding_size=192):",
  "        super().__init__()",
  "        self.net = nn.Linear(feat_dim, embedding_size)",
  "",
  "class EnhancedCodec(nn.Module):",
  "    def __init__(self, **kw):",
  "        super().__init__()",
  "        self.q = nn.Linear(8, 8)",
  "",
  "    def load_checkpoint(self, checkpoint_path):",
  "        # 复刻真实语义：missing/shape 不符时以当前值填充（meta 路线下即垃圾）——silent 面",
  "        checkpoint_dict = torch.load(checkpoint_path, map_location='cpu')",
  "        saved = checkpoint_dict['model']",
  "        sd = self.state_dict()",
  "        new = {}",
  "        for k, v in sd.items():",
  "            if k in saved and saved[k].shape == v.shape:",
  "                new[k] = saved[k]",
  "            else:",
  "                new[k] = v",
  "        self.load_state_dict(new)",
  "",
  "def load_checkpoint(model, model_pth):",
  "    # 复刻 indextts.utils.checkpoint.load_checkpoint 的静默语义",
  "    checkpoint = torch.load(model_pth, map_location='cpu')",
  "    checkpoint = checkpoint['model'] if 'model' in checkpoint else checkpoint",
  "    model.load_state_dict(checkpoint, strict=False)",
  "    return {}",
  "",
  "def load_checkpoint2(model, optimizer, path, load_only_params=True, ignore_modules=(), is_distributed=False, load_ema=False):",
  "    # 复刻 s2mel 面：'module.' 前缀剥离 + shape 过滤 + strict=False",
  "    state = torch.load(path, map_location='cpu')",
  "    params = state['net']",
  "    for key in model.models:",
  "        if key in params and key not in ignore_modules:",
  "            for k in list(params[key].keys()):",
  "                if k.startswith('module.'):",
  "                    params[key][k[len('module.'):]] = params[key][k]",
  "                    del params[key][k]",
  "            msd = model.models[key].state_dict()",
  "            filtered = {k: v for k, v in params[key].items() if k in msd and v.shape == msd[k].shape}",
  "            model.models[key].load_state_dict(filtered, strict=False)",
  "    model.eval()",
  "    return model, optimizer, 0, 0",
  "",
  "bigvgan = types.SimpleNamespace()",
  "",
  "class _BigVGAN(nn.Module):",
  "    def __init__(self, h, use_cuda_kernel=False):",
  "        super().__init__()",
  "        self.gen = nn.Linear(4, 4)",
  "",
  "    @classmethod",
  "    def from_pretrained(cls, model_id, use_cuda_kernel=False):",
  "        # 复刻 HF mixin 面的 strict load + except 二次 load（二次不在 try 内）",
  "        model = cls({}, use_cuda_kernel=use_cuda_kernel)",
  "        import os",
  "        checkpoint_dict = torch.load(os.path.join(model_id, 'bigvgan_generator.pt'), map_location='cpu')",
  "        try:",
  "            model.load_state_dict(checkpoint_dict['generator'])",
  "        except RuntimeError:",
  "            model.load_state_dict(checkpoint_dict['generator'])",
  "        return model",
  "",
  "bigvgan.BigVGAN = _BigVGAN",
].join("\n");

/** drive 脚本：逐场景跑闸行为，stdout 每行一 JSON 结果（vitest 侧对账） */
const TOY_DRIVE_PY = [
  "import json",
  "import os",
  "import sys",
  "import tempfile",
  "import types",
  "",
  "sys.path.insert(0, os.environ['SHIMS_DIR'])",
  "sys.path.insert(0, os.environ['TOY_DIR'])",
  "import torch",
  "import fake_engine",
  "import indextts_fastload as fl",
  "",
  "root = tempfile.mkdtemp()",
  "",
  "def full_state(module):",
  "    return {k: torch.zeros(v.shape, dtype=torch.float32) for k, v in module.state_dict().items()}",
  "",
  "def emit(name, ok, detail=''):",
  "    print(json.dumps({'case': name, 'ok': bool(ok), 'detail': str(detail)[:400]}))",
  "",
  "results = {}",
  "",
  "# S0 build 段原子性（先于正常 install 验证全局未被污染）：",
  "# 必需属性齐备但 UnifiedVoice 是不可继承类型（bool）→ install 在构建期抛 TypeError，",
  "# 引擎属性表与全局 torch.load 都必须停在未触碰态（审查 finding：装配半程异常不留半装配态）",
  "bad = types.ModuleType('bad_engine')",
  "class _Ok:",
  "    def __init__(self, *a, **k):",
  "        pass",
  "def _fn(*a, **k):",
  "    return {}",
  "bad.UnifiedVoice = bool",
  "bad.MyModel = _Ok",
  "bad.CAMPPlus = _Ok",
  "bad.EnhancedCodec = _Ok",
  "bad.load_checkpoint = _fn",
  "bad.load_checkpoint2 = _fn",
  "try:",
  "    fl.install_fast_load_patch(bad)",
  "    emit('build-atomic-no-pollution', False, 'install 未按预期抛错')",
  "except TypeError:",
  "    untouched = bad.UnifiedVoice is bool and bad.MyModel is _Ok and bad.load_checkpoint is _fn",
  "    clean_load = getattr(torch.load, '_say_fastload_mmap', False) is False",
  "    emit('build-atomic-no-pollution', untouched and clean_load, f'untouched={untouched} clean_torch_load={clean_load}')",
  "",
  "# 正常装配：fake_engine 模块属性被 patch 后保留 wrapped 态，跨场景共享是预期形态",
  "info = fl.install_fast_load_patch(fake_engine)",
  "results['install'] = info",
  "emit('install-applied', info.get('applied') is True, info)",
  "",
  "try:",
  "    # S0b 同进程二次 install：闸包装类与闸闭包必须原对象返回，不沿继承链/闭包链叠层",
  "    codec1, gpt1, s2_1 = fake_engine.EnhancedCodec, fake_engine.load_checkpoint, fake_engine.load_checkpoint2",
  "    info2 = fl.install_fast_load_patch(fake_engine)",
  "    emit('double-install-idempotent',",
  "         info2.get('applied') is True and fake_engine.EnhancedCodec is codec1",
  "         and fake_engine.load_checkpoint is gpt1 and fake_engine.load_checkpoint2 is s2_1, info2)",
  "except Exception as e:",
  "    emit('double-install-idempotent', False, f'{type(e).__name__}: {e}')",
  "",
  "try:",
  "    # S1 meta 建模生效：构造后参数在真实 CPU 存储（to_empty 物化），非 meta",
  "    m = fake_engine.UnifiedVoice(layers=2, model_dim=8)",
  "    devs = {p.device.type for p in m.parameters()}",
  "    emit('meta-wrap-cpu', devs == {'cpu'} and not any(p.is_meta for p in m.parameters()), sorted(devs))",
  "except Exception as e:",
  "    emit('meta-wrap-cpu', False, f'{type(e).__name__}: {e}')",
  "",
  "try:",
  "    # S2 gpt 面：全覆盖 ckpt 正常通过（闸不误杀）",
  "    sd = full_state(m)",
  "    torch.save({'model': sd}, os.path.join(root, 'gpt_full.pth'))",
  "    fake_engine.load_checkpoint(m, os.path.join(root, 'gpt_full.pth'))",
  "    loaded_ok = bool(torch.equal(m.out.weight, sd['out.weight']))",
  "    emit('gpt-full-pass', loaded_ok)",
  "except Exception as e:",
  "    emit('gpt-full-pass', False, f'{type(e).__name__}: {e}')",
  "",
  "try:",
  "    # S3 gpt 面红测：故意缺键 → FastLoadGateError fatal 拒载（消息含 missing 与计数）",
  "    m2 = fake_engine.UnifiedVoice(layers=2, model_dim=8)",
  "    sd2 = full_state(m2)",
  "    del sd2['out.weight']",
  "    torch.save({'model': sd2}, os.path.join(root, 'gpt_missing.pth'))",
  "    try:",
  "        fake_engine.load_checkpoint(m2, os.path.join(root, 'gpt_missing.pth'))",
  "        emit('gpt-missing-fatal', False, 'no raise')",
  "    except fl.FastLoadGateError as e:",
  "        emit('gpt-missing-fatal', 'missing' in str(e).lower(), e)",
  "except Exception as e:",
  "    emit('gpt-missing-fatal', False, f'{type(e).__name__}: {e}')",
  "",
  "try:",
  "    # S4 codec 面红测：复刻的填旧值静默面必须被闸拦截（shape 不符同样拒）",
  "    c = fake_engine.EnhancedCodec()",
  "    sd3 = full_state(c)",
  "    del sd3['q.weight']",
  "    torch.save({'model': sd3}, os.path.join(root, 'codec_missing.pth'))",
  "    try:",
  "        c.load_checkpoint(os.path.join(root, 'codec_missing.pth'))",
  "        emit('codec-missing-fatal', False, 'no raise')",
  "    except fl.FastLoadGateError as e:",
  "        emit('codec-missing-fatal', 'missing' in str(e).lower(), e)",
  "    # shape 不符：值全对但维度错的 ckpt",
  "    c2 = fake_engine.EnhancedCodec()",
  "    bad = {'model': {'q.weight': torch.zeros(3, 3), 'q.bias': torch.zeros(3)}}",
  "    torch.save(bad, os.path.join(root, 'codec_shape.pth'))",
  "    try:",
  "        c2.load_checkpoint(os.path.join(root, 'codec_shape.pth'))",
  "        emit('codec-shape-fatal', False, 'no raise')",
  "    except fl.FastLoadGateError as e:",
  "        emit('codec-shape-fatal', True, e)",
  "except Exception as e:",
  "    emit('codec-missing-fatal', False, f'{type(e).__name__}: {e}')",
  "    emit('codec-shape-fatal', False, f'cascade: {type(e).__name__}: {e}')",
  "",
  "try:",
  "    # S5 s2mel 面红测：子模块整体缺位 + 'module.' 前缀形态必须正常通过（前缀剥离复刻后不误杀）",
  "    mm = fake_engine.MyModel(cfg={})",
  "    net = {k: full_state(sub) for k, sub in mm.models.items()}",
  "    torch.save({'net': net}, os.path.join(root, 's2mel_full.pth'))",
  "    fake_engine.load_checkpoint2(mm, None, os.path.join(root, 's2mel_full.pth'))",
  "    emit('s2mel-full-pass', True)",
  "    mm2 = fake_engine.MyModel(cfg={})",
  "    net2 = {k: full_state(sub) for k, sub in mm2.models.items()}",
  "    del net2['length_regulator']",
  "    torch.save({'net': net2}, os.path.join(root, 's2mel_missing_sub.pth'))",
  "    try:",
  "        fake_engine.load_checkpoint2(mm2, None, os.path.join(root, 's2mel_missing_sub.pth'))",
  "        emit('s2mel-submodule-fatal', False, 'no raise')",
  "    except fl.FastLoadGateError:",
  "        emit('s2mel-submodule-fatal', True)",
  "    # 前缀形态：params 键带 module. 前缀，剥离后应全覆盖通过",
  "    mm3 = fake_engine.MyModel(cfg={})",
  "    net3 = {k: {('module.' + kk): vv for kk, vv in full_state(sub).items()} for k, sub in mm3.models.items()}",
  "    torch.save({'net': net3}, os.path.join(root, 's2mel_prefix.pth'))",
  "    fake_engine.load_checkpoint2(mm3, None, os.path.join(root, 's2mel_prefix.pth'))",
  "    emit('s2mel-prefix-pass', True)",
  "except Exception as e:",
  "    emit('s2mel-full-pass', False, f'{type(e).__name__}: {e}')",
  "    emit('s2mel-submodule-fatal', False, f'cascade: {type(e).__name__}: {e}')",
  "    emit('s2mel-prefix-pass', False, f'cascade: {type(e).__name__}: {e}')",
  "",
  "try:",
  "    # S6 bigvgan 面：strict load 天然闸，缺键必须让 from_pretrained 整体抛错（fatal 链完好）",
  "    d = os.path.join(root, 'bigvgan_dir')",
  "    os.makedirs(d, exist_ok=True)",
  "    probe = fake_engine.bigvgan.BigVGAN({})",
  "    g = {k: torch.zeros(v.shape) for k, v in probe.state_dict().items()}",
  "    del g['gen.bias']",
  "    torch.save({'generator': g}, os.path.join(d, 'bigvgan_generator.pt'))",
  "    try:",
  "        fake_engine.bigvgan.BigVGAN.from_pretrained(d)",
  "        emit('bigvgan-missing-fatal', False, 'no raise')",
  "    except RuntimeError:",
  "        emit('bigvgan-missing-fatal', True)",
  "except Exception as e:",
  "    emit('bigvgan-missing-fatal', False, f'{type(e).__name__}: {e}')",
  "",
  "try:",
  "    # S7 mmap 注入：zip 存档正常读取（闸后复读同路径），legacy 非 zip 存档回落不炸",
  "    t = torch.zeros(2, 2)",
  "    zip_p = os.path.join(root, 'zip_t.pt')",
  "    torch.save(t, zip_p)  # torch>=2.0 默认新 zipfile 形态，mmap 可用",
  "    got = torch.load(zip_p)",
  "    legacy_p = os.path.join(root, 'legacy_t.pt')",
  "    torch.save(t, legacy_p, _use_new_zipfile_serialization=False)",
  "    got2 = torch.load(legacy_p)",
  "    emit('mmap-inject-pass', bool(torch.equal(got, t)) and bool(torch.equal(got2, t)))",
  "    # 调用方显式传 mmap=False 不被覆写",
  "    got3 = torch.load(zip_p, mmap=False)",
  "    emit('mmap-explicit-respect', bool(torch.equal(got3, t)))",
  "except Exception as e:",
  "    emit('mmap-inject-pass', False, f'{type(e).__name__}: {e}')",
  "    emit('mmap-explicit-respect', False, f'cascade: {type(e).__name__}: {e}')",
].join("\n");

interface DriveCase {
  case: string;
  ok: boolean;
  detail: string;
}

function runToyDrive(): DriveCase[] {
  const root = makeTempRoot("say-s4-toy-");
  try {
    writeFileSync(join(root, "fake_engine.py"), TOY_ENGINE_PY);
    writeFileSync(join(root, "drive.py"), TOY_DRIVE_PY);
    const out = execFileSync(VENV_PYTHON as string, [join(root, "drive.py")], {
      timeout: 180_000,
      env: { ...process.env, SHIMS_DIR: SHIMS_DIR, TOY_DIR: root, PYTHONPATH: "" },
    }).toString();
    return out
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as DriveCase);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("fastload patch · toy 引擎闸行为（venv 门控）", () => {
  it.skipIf(!VENV)(
    "三静默面缺键/缺 shape 必 fatal、全覆盖不误杀、mmap 注入生效",
    () => {
      const cases = runToyDrive();
      const byName = new Map(cases.map((c) => [c.case, c]));
      for (const name of [
        "build-atomic-no-pollution",
        "install-applied",
        "double-install-idempotent",
        "meta-wrap-cpu",
        "gpt-full-pass",
        "gpt-missing-fatal",
        "codec-missing-fatal",
        "codec-shape-fatal",
        "s2mel-full-pass",
        "s2mel-submodule-fatal",
        "s2mel-prefix-pass",
        "bigvgan-missing-fatal",
        "mmap-inject-pass",
        "mmap-explicit-respect",
      ]) {
        const c = byName.get(name);
        expect(c, `drive 场景 ${name} 未产出`).toBeDefined();
        expect(c!.ok, `${name}: ${c!.detail}`).toBe(true);
      }
    },
    180_000,
  );
});

describe("fastload patch · stub 保护（无条件）", () => {
  it("stub 引擎形态 install 整体 no-op：无 torch 走 no-torch 层、有 torch 但缺引擎属性走 not-engine 层，属性零改动", () => {
    const root = makeTempRoot("say-s4-stub-");
    try {
      // 两层保护都验：本机系统 python3 实测带 torch（S3 stub 套件照跑），
      // 真实生效层是 not-engine（目标类属性缺失即旁路）；无 torch 环境走 no-torch 层
      const drive = [
        "import json, sys, types",
        "sys.path.insert(0, sys.argv[1])",
        "import indextts_fastload as fl",
        "has_torch = True",
        "try:",
        "    import torch",
        "except ImportError:",
        "    has_torch = False",
        "mod = types.ModuleType('stub_engine')",
        "class IndexTTS2: pass",
        "mod.IndexTTS2 = IndexTTS2",
        "info = fl.install_fast_load_patch(mod)",
        "expect_reason = 'no-torch' if not has_torch else 'not-engine'",
        "print(json.dumps({'case':'stub-noop','ok': info.get('applied') is False and info.get('reason') == expect_reason, 'detail': str(info) + ' has_torch=' + str(has_torch)}))",
        "print(json.dumps({'case':'stub-attr-untouched','ok': mod.IndexTTS2 is IndexTTS2 and info.get('patched') == [], 'detail':''}))",
      ].join("\n");
      const py = join(root, "drive_stub.py");
      writeFileSync(py, drive);
      const out = execFileSync("python3", [py, SHIMS_DIR], { timeout: 60_000, env: { ...process.env, PYTHONPATH: "" } }).toString();
      const cases = out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as DriveCase);
      for (const name of ["stub-noop", "stub-attr-untouched"]) {
        const c = cases.find((x) => x.case === name);
        expect(c, `${name} 未产出`).toBeDefined();
        expect(c!.ok, `${name}: ${c!.detail}`).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("indextts shim · 空权重集成红测（真实引擎代码门控）", () => {
  it.skipIf(!ENGINE)(
    "故意缺键（空 gpt.pth）→ per-call fatal 拒载：帧含 fastload 归因，stderr 有自报行",
    async () => {
      const root = makeTempRoot("say-s4-int-");
      try {
        // fixture 必须先于 spawn 就位：加载竞态会把 fatal 归因打成 FileNotFoundError 假绿红
        copyFileSync(join(CHECKPOINTS, "config.yaml"), join(root, "config.yaml"));
        pyWrite(root, [
          "import os, torch",
          "torch.save({'model': {}}, os.path.join(os.environ['FIXTURE_ROOT'], 'gpt.pth'))",
        ].join("\n"));

        const run = await runShimPerCall(
          [{ id: 1, text: "测试", ref_audio_path: "x", text_lang: "zh" }],
          { modelsDir: root, timeoutMs: 360_000, extraEnv: { HF_HUB_OFFLINE: "1" }, cwd: root },
        );
        const fatal = run.frames.find((f) => f.type === "fatal");
        expect(fatal, `stdout 无 fatal 帧：${run.frames.map((f) => f.type).join(",")}；stderr 尾=${run.stderr.slice(-600)}`).toBeDefined();
        expect(String(fatal!.message), "fatal 消息应含闸归因").toMatch(/fastload/i);
        expect(String(fatal!.message)).toMatch(/missing/i);
        // 取证锚点规范：patch 生效以被测运行时自报行为准，不信外部期望
        expect(run.stderr, "stderr 应有 fastload 装配自报行").toMatch(/\[fastload\] applied=True/);
        // 协议面形态：fatal 后进程退出码 1（per-call 既有契约）
        expect(run.exitCode).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    400_000,
  );
});
