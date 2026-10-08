"""indextts shim 的冷启动瘦身 patch（热启动 S4，票 01 实证组合的工程化落点）。

零引擎源码改动：全部生效面是对 `indextts.infer_v2_5` **模块属性**的运行时替换——
引擎 `__init__` 以属性名引用构造器与加载函数，替换属性即改变其装配行为。

三条路径（票 01 实测 ready 23.1s → 8.4-11.3s，同负载 −60~65%）：

1. meta 建模 + to_empty：randn 随机初始化建模（UnifiedVoice 一段占 ready 的 63%）
   改在 meta device 上只建结构（毫秒级），随即 `to_empty(device='cpu')` 物化空存储；
   权重照旧经引擎自身的 load 路径写满，之后 `.to(device)` 搬运形态不变。
   **前提是全量覆盖**：to_empty 留未初始化内存，checkpoint 未覆盖的键即垃圾——
   所以配 3 的闸是安全模型的一部分，不是可选体检。
2. torch.load(mmap=True)：权重 zip 存档内存映射惰性分页，峰值 RSS 降 ~5GB
   （swap 风暴机器的实际体感收益大于静态差值）；非 zip 形态自动回落普通加载。
3. missing-keys 全覆盖闸：三个 strict=False/手动过滤的静默加载面（gpt load_checkpoint、
   codec EnhancedCodec.load_checkpoint、s2mel load_checkpoint2）在引擎原逻辑跑完后
   旁路复读 ckpt 做「model 全部 state_dict 键 ⊆ ckpt 且 shape 一致」校验，
   不满足抛 FastLoadGateError → shim 既有 fatal 通道拒载（daemon 自退、per-call fatal 帧）。
   CAMPPlus/BigVGAN 走 strict load 天然闸，不重复设闸（BigVGAN 的 except 二次 load
   不在 try 内，缺键仍向上传播）。

fp32 数值路径完整保留——bf16/fp16 已被票 01 实证否决（MPS 采样崩溃），不得引入。

适用性保护：目标引擎属性齐备才装配（fake stub 引擎与无 torch 解释器整体 no-op），
S3 的 stub 测试套件与降级链依赖这一条；patch 装配自身异常不得阻断出声——
调用方（shim）捕获后按未打补丁的原始加载路径继续。
"""

import os
import types

ENGINE_ATTRS = ("UnifiedVoice", "MyModel", "CAMPPlus", "EnhancedCodec", "load_checkpoint", "load_checkpoint2")
OPTIONAL_ATTRS = ("bigvgan",)


class FastLoadGateError(RuntimeError):
    """checkpoint 未全覆盖模型结构：meta 路线下这是「未初始化垃圾进推理」的入口，必须拒载。"""


def _verify_coverage(model, saved, label):
    """model 的每个 state_dict 键必须出现在 saved 且 shape 一致，否则 FastLoadGateError。

    单向包含（model ⊆ ckpt）：ckpt 多余的 unexpected 键沿用引擎语义跳过——官方存档
    可能带 optimizer 残留，拒绝它们会误杀生产路径。shape 检查兜 codec/s2mel 的
    手动过滤静默面（strict load 面 torch 天然报错，不经这里）。
    """
    msd = model.state_dict()
    missing = [k for k in msd if k not in saved]
    if missing:
        raise FastLoadGateError(
            f"{label} fastload gate: {len(missing)} param(s) missing from checkpoint, e.g. {missing[:5]}"
        )
    mismatched = [k for k, v in msd.items() if tuple(saved[k].shape) != tuple(v.shape)]
    if mismatched:
        raise FastLoadGateError(
            f"{label} fastload gate: {len(mismatched)} shape-mismatched param(s), e.g. {mismatched[:5]}"
        )


def _meta_wrapped(cls):
    """randn 建模 → meta 建模 + CPU 空存储物化。load 语义与后续 .to(device) 全部不动。"""
    if getattr(cls, "_say_fastload_wrapped", False):
        return cls  # 幂等：重复 install 不对已包装类叠层（双层 meta 无害但掩盖装配历史）

    import torch

    class FastLoadWrapped(cls):
        def __init__(self, *args, **kwargs):
            with torch.device("meta"):
                super().__init__(*args, **kwargs)
            self.to_empty(device="cpu")

    FastLoadWrapped.__name__ = cls.__name__
    FastLoadWrapped.__qualname__ = cls.__qualname__
    FastLoadWrapped.__module__ = cls.__module__
    FastLoadWrapped._say_fastload_wrapped = True
    return FastLoadWrapped


def _wrap_codec(cls):
    """EnhancedCodec：meta 包装之外再覆写实例方法 load_checkpoint——
    其原实现把 missing/shape 不符的键以当前值填充（meta 路线下即垃圾）且只 log warning，
    是五个建模面里最静默的一个，闸挂在这里。"""
    Wrapped = _meta_wrapped(cls)

    class CodecFastLoad(Wrapped):
        def load_checkpoint(self, checkpoint_path):
            super().load_checkpoint(checkpoint_path)
            import torch

            ckpt = torch.load(checkpoint_path, map_location="cpu")
            _verify_coverage(self, ckpt["model"], "codec")

    CodecFastLoad.__name__ = "EnhancedCodec"
    return CodecFastLoad


def _wrap_gpt_loader(orig):
    """indextts.utils.checkpoint.load_checkpoint：strict=False 吞 missing（print 了事）。
    原函数照跑（行为单一事实源在引擎侧），跑完 mmap 复读做覆盖校验——mmap 视图只读键
    与 shape 不触碰页数据，gpt.pth 3.3GB 复读实测 0.1s 级。"""
    import torch

    def fastload_load_checkpoint(model, model_pth):
        configs = orig(model, model_pth)
        ckpt = torch.load(model_pth, map_location="cpu")
        saved = ckpt["model"] if "model" in ckpt else ckpt
        _verify_coverage(model, saved, "gpt")
        return configs

    return fastload_load_checkpoint


def _strip_ddp_prefix(params):
    return {k[len("module.") :] if k.startswith("module.") else k: v for k, v in params.items()}


def _wrap_s2mel_loader(orig):
    """s2mel load_checkpoint2：按子模块组织、shape 过滤 + strict=False 双重静默。
    校验复刻其消费形态（'module.' 前缀剥离；ignore_modules 跳过；load_ema 的 ema 覆写
    不改键集合，按 params 校验仍成立——引擎调用点 load_ema 恒 False）。"""
    import torch

    def fastload_load_checkpoint2(model, optimizer, path, load_only_params=True, ignore_modules=(), is_distributed=False, load_ema=False):
        result = orig(
            model, optimizer, path,
            load_only_params=load_only_params, ignore_modules=ignore_modules,
            is_distributed=is_distributed, load_ema=load_ema,
        )
        state = torch.load(path, map_location="cpu")
        params = state["net"]
        for key in model.models:
            if key in ignore_modules:
                continue
            if key not in params:
                raise FastLoadGateError(f"s2mel fastload gate: submodule '{key}' absent from checkpoint")
            _verify_coverage(model.models[key], _strip_ddp_prefix(params[key]), f"s2mel.{key}")
        return result

    return fastload_load_checkpoint2


def _patch_torch_load():
    """全局 torch.load 注入 mmap=True（仅路径形态且调用方未显式传 mmap 时）。

    mmap 只支持 zipfile 存档：非 zip（legacy pickle）回落普通加载一次——引擎六个存档
    实测全 zip 零回落，但权重形态随上游安装渠道漂移，回落是出声保底不是二次防线。
    """
    import torch
    import inspect

    orig = torch.load
    if getattr(orig, "_say_fastload_mmap", False):
        return
    supports_mmap = "mmap" in inspect.signature(orig).parameters

    def mmap_load(*args, **kwargs):
        if supports_mmap and kwargs.get("mmap") is None and len(args) >= 1 and isinstance(args[0], (str, os.PathLike)):
            kwargs["mmap"] = True
            try:
                return orig(*args, **kwargs)
            except Exception:
                kwargs.pop("mmap")
                return orig(*args, **kwargs)
        return orig(*args, **kwargs)

    mmap_load._say_fastload_mmap = True  # 幂等标记：重复 install 不叠层
    torch.load = mmap_load


def install_fast_load_patch(engine_module) -> dict:
    """对 indextts.infer_v2_5 模块对象装配快速加载 patch。

    返回 {"applied": bool, "reason": str|None, "patched": list[str]}——调用方（shim）
    负责把结果打成自报行（取证锚点：被测运行时自报，非外部期望）。
    整体原子：必需属性（五建模/加载面）不齐备即整体不装（not-engine），
    半装配的引擎行为比没装配更难归因；装配序列 build 先行 apply 收口，
    构建期异常同样不留半装配态（属性表与全局 torch.load 到 apply 段才被触碰）；
    可选面（bigvgan）在位才装。
    """
    try:
        import torch  # noqa: F401 — 探测解释器能力，patch 本体全部惰性引用
    except ImportError:
        return {"applied": False, "reason": "no-torch", "patched": []}

    if not isinstance(engine_module, types.ModuleType) or not all(hasattr(engine_module, a) for a in ENGINE_ATTRS):
        return {"applied": False, "reason": "not-engine", "patched": []}

    # build 段：纯对象构造、零副作用——中途任何异常都不留半装配态（属性表与全局 torch.load 未触碰）
    wrapped_classes = {
        "UnifiedVoice": _meta_wrapped(engine_module.UnifiedVoice),
        "MyModel": _meta_wrapped(engine_module.MyModel),
        "CAMPPlus": _meta_wrapped(engine_module.CAMPPlus),
        "EnhancedCodec": _wrap_codec(engine_module.EnhancedCodec),
    }
    wrapped_loaders = {
        "load_checkpoint": _wrap_gpt_loader(engine_module.load_checkpoint),
        "load_checkpoint2": _wrap_s2mel_loader(engine_module.load_checkpoint2),
    }
    bigvgan_mod = getattr(engine_module, "bigvgan", None)
    bigvgan_wrapped = None
    if bigvgan_mod is not None and getattr(bigvgan_mod, "BigVGAN", None) is not None:
        bigvgan_wrapped = _meta_wrapped(bigvgan_mod.BigVGAN)

    # apply 段：副作用集中执行，全局 torch.load 是最后一步——它之前引擎属性已换完，
    # 它之后无逻辑，不存在「引擎半包装 + torch.load 未 mmap」的中间态
    for name, cls in wrapped_classes.items():
        setattr(engine_module, name, cls)
    for name, fn in wrapped_loaders.items():
        setattr(engine_module, name, fn)
    if bigvgan_wrapped is not None:
        bigvgan_mod.BigVGAN = bigvgan_wrapped
    _patch_torch_load()

    patched = ["meta:UnifiedVoice", "meta:MyModel", "meta:CAMPPlus", "meta+gate:EnhancedCodec", "gate:gpt", "gate:s2mel", "torch.load(mmap)"]
    if bigvgan_wrapped is not None:
        patched.insert(-1, "meta:BigVGAN")
    return {"applied": True, "reason": None, "patched": patched}
