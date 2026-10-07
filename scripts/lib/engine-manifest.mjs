// 四引擎安装清单（engine-v2 S1）：仓库、Python 版本、venv 依赖步骤、权重文件与校验和、FireRed patch。
// 数据源 = docs/research/261006-*.md 实测报告 + ModelScope repo/files API（2026-10-07 现取的 size/sha256）。
// 路径解析走 XDG 语义（对齐 src/paths.ts），env 注入使单测可用临时 HOME，绝不触碰真实 say-lab。
import { homedir } from "node:os";
import path from "node:path";

/** 空串视同未设（shell 里 export XDG_DATA_HOME= 是常见「取消覆盖」写法） */
function rootDir(override, fallback) {
  return override && override.length > 0 ? override : fallback;
}

/** say-lab 根：调研四报告的实际落位 ~/.local/share/say-lab/<engine>/ */
export function sayLabRoot(env = process.env) {
  const home = rootDir(env.HOME, homedir());
  const data = rootDir(env.XDG_DATA_HOME, path.join(home, ".local", "share"));
  return path.join(data, "say-lab");
}

export function engineDir(engine, env = process.env) {
  return path.join(sayLabRoot(env), engine);
}

/** PyPI 镜像：uv 系命令统一注入（国内直连 PyPI 会挂死，清华/阿里实测可用；报告口径 UV_DEFAULT_INDEX） */
export const UV_INDEX = "https://pypi.tuna.tsinghua.edu.cn/simple";

/**
 * 权重源通道：sources 按优先级排列，下载器逐通道尝试。
 * ModelScope aria2 直连实测最快（上海网络三票一致），hf-mirror 兜底；HF 直连超时不入通道表。
 * MS resolve URL 的 308 重定向会把并行分段串到别的文件（VoxCPM 票实证），故下载恒单文件逐个 + sha256 全量校验。
 */
const ms = (repo, file) => ({ net: "modelscope", url: `https://modelscope.cn/models/${repo}/resolve/master/${file}` });
const hf = (repo, file) => ({ net: "hf-mirror", url: `https://hf-mirror.com/${repo}/resolve/main/${file}` });

/**
 * @typedef {Object} WeightAsset
 * @property {string} file 相对 engineDir 的落位路径（引擎运行时读取的最终位置）
 * @property {number} size 精确字节数（ModelScope API 实测）
 * @property {string} sha256 ModelScope API 实测校验和
 * @property {{net:string,url:string}[]} sources 有序下载通道
 * @property {("auto"|undefined)} [tier] auto = 引擎首跑自拉的隐藏依赖（状态查询提示但不判 partial）
 * @property {{strip:number,delete?:boolean}} [archive] zip/tar.gz 包：解压 strip 层后落位，delete = 解压后删包
 */

/** GPT-SoVITS v2：默认引擎（蓝图裁决 1），CPU 档；底模 zip 一把梭 + G2PW onnx 导出件单独包 */
const GPTSOVITS = {
  id: "gptsovits",
  repo: "https://github.com/RVC-Boss/GPT-SoVITS",
  repoDir: "GPT-SoVITS",
  python: "3.11",
  /** 重建四步（报告「可复用的环境资产」节）：requirements + torchcodec/resampy 表外包；open_jtalk 字典见权重条目 linkIntoVenvPackage */
  deps: {
    steps: [
      { cmd: ["uv", "pip", "install", "-r", "requirements.txt"], cwd: "repo", index: true },
      { cmd: ["uv", "pip", "install", "torchcodec", "resampy"], cwd: "repo", index: true },
    ],
  },
  weights: [
    {
      file: "GPT-SoVITS/GPT_SoVITS/pretrained_models",
      size: 4563188367,
      sha256: "66274394318cbf134b78d0d5aeeccb73e96f5d43cf6876ac43560a972cb1f3fc",
      sources: [ms("XXXXRT/GPT-SoVITS-Pretrained", "pretrained_models.zip"), hf("XXXXRT/GPT-SoVITS-Pretrained", "pretrained_models.zip")],
      archive: { strip: 1, delete: true },
    },
    {
      file: "GPT-SoVITS/GPT_SoVITS/text/G2PWModel",
      size: 588856634,
      sha256: "46292be0374a49308069233cd5c147ae4c41806558e4781a2467a31a4d8099da",
      sources: [ms("XXXXRT/GPT-SoVITS-Pretrained", "G2PWModel.zip"), hf("XXXXRT/GPT-SoVITS-Pretrained", "G2PWModel.zip")],
      archive: { strip: 1, delete: true },
    },
    {
      file: "open_jtalk_dic_utf_8-1.11",
      size: 23646843,
      sha256: "fe6ba0e43542cef98339abdffd903e062008ea170b04e7e2a35da805902f382a",
      sources: [ms("XXXXRT/GPT-SoVITS-Pretrained", "open_jtalk_dic_utf_8-1.11.tar.gz"), hf("XXXXRT/GPT-SoVITS-Pretrained", "open_jtalk_dic_utf_8-1.11.tar.gz")],
      archive: { strip: 0, delete: true },
      /** 解压产物需移入 venv 的 pyopenjtalk 包目录才生效（install.sh 同款动作）；link 步骤幂等补链 */
      linkIntoVenvPackage: "pyopenjtalk",
    },
  ],
  patches: [],
};

/** VoxCPM2：流式质量上限选项（裁决 2）；PyPI 2.0.3 落后 master（无 seed），恒从克隆仓安装 */
const VOXCPM = {
  id: "voxcpm",
  repo: "https://github.com/OpenBMB/VoxCPM",
  repoDir: "VoxCPM",
  python: "3.12",
  deps: {
    steps: [{ cmd: ["uv", "pip", "install", "."], cwd: "repo", index: true }],
  },
  weights: [
    { file: "models/model.safetensors", size: 4580080592, sha256: "f7f964cfa9da23653baec6e6f7750719977ad944ed9f95fe52fe3a620506891d", sources: [ms("openbmb/VoxCPM2", "model.safetensors"), hf("openbmb/VoxCPM2", "model.safetensors")] },
    { file: "models/audiovae.pth", size: 376951122, sha256: "94b5d51e107e0507d4acc976cfdadb64edd6fd06d1f751dadbf2fd1594274bf1", sources: [ms("openbmb/VoxCPM2", "audiovae.pth"), hf("openbmb/VoxCPM2", "audiovae.pth")] },
    { file: "models/config.json", size: 4336, sha256: "405f0dcd92f7feba6011ed4eac5c8d4f74cba9712f07fd5cfa3063bbdd95402c", sources: [ms("openbmb/VoxCPM2", "config.json"), hf("openbmb/VoxCPM2", "config.json")] },
    { file: "models/tokenizer.json", size: 3676772, sha256: "f8984687e4a92a3503d521396d454b7d68e9fdaab2a0288eb3536c7c1aa4bc20", sources: [ms("openbmb/VoxCPM2", "tokenizer.json"), hf("openbmb/VoxCPM2", "tokenizer.json")] },
    { file: "models/tokenizer_config.json", size: 5059, sha256: "e78a3ebb48a0b9437efd1823b6b726c823da89e49dd8bcc90c02419d9baa772b", sources: [ms("openbmb/VoxCPM2", "tokenizer_config.json"), hf("openbmb/VoxCPM2", "tokenizer_config.json")] },
    { file: "models/special_tokens_map.json", size: 1632, sha256: "068594063e37662c02b21acf42ebb334ef6a74fb810e68a2368f88f08351de76", sources: [ms("openbmb/VoxCPM2", "special_tokens_map.json"), hf("openbmb/VoxCPM2", "special_tokens_map.json")] },
    { file: "models/tokenization_voxcpm2.py", size: 2895, sha256: "84489ea32b6ee0cae22ed5480cacb6df85c46624c3119be9a2021c3649a12729", sources: [ms("openbmb/VoxCPM2", "tokenization_voxcpm2.py"), hf("openbmb/VoxCPM2", "tokenization_voxcpm2.py")] },
  ],
  patches: [],
};

/** IndexTTS 2.5：duration_factor 节奏控制差异化（裁决 3）；首跑隐藏依赖走引擎自拉（need_proxy 自动镜像，实测成功） */
const INDEXTTS = {
  id: "indextts",
  repo: "https://github.com/index-tts/index-tts",
  repoDir: "index-tts",
  python: "3.11",
  /** uv sync 自建 .venv（仓库 pyproject 权威）；.python-version pin 3.11.13 与本机 pyenv 冲突，须 --python 3.11 显式指定 */
  deps: {
    steps: [{ cmd: ["uv", "sync", "--python", "3.11"], cwd: "repo", index: true, sync: true }],
  },
  weights: [
    { file: "checkpoints/gpt.pth", size: 3259599833, sha256: "43a8f4c30eccdf201958d3b9713511482c19d56dc20b0b1c4ee1e6b080b19d85", sources: [ms("IndexTeam/IndexTTS-2.5", "gpt.pth"), hf("IndexTeam/IndexTTS-2.5", "gpt.pth")] },
    { file: "checkpoints/codec.pth", size: 607290935, sha256: "d15cbed16a40f478438c961fb043f68dfa6353bf56c966761315db3433e9722c", sources: [ms("IndexTeam/IndexTTS-2.5", "codec.pth"), hf("IndexTeam/IndexTTS-2.5", "codec.pth")] },
    { file: "checkpoints/s2mel.pth", size: 414908601, sha256: "9b1b0003fc189c94cc349758d7ebc25f903b7eb2de4602879959cc64ce816456", sources: [ms("IndexTeam/IndexTTS-2.5", "s2mel.pth"), hf("IndexTeam/IndexTTS-2.5", "s2mel.pth")] },
    { file: "checkpoints/qwen0.6bemo4-merge/model.safetensors", size: 1192135096, sha256: "11293257a8df593c154a8ecd5fc039f3076de35411e35f06d41b471e136f6641", sources: [ms("IndexTeam/IndexTTS-2.5", "qwen0.6bemo4-merge/model.safetensors"), hf("IndexTeam/IndexTTS-2.5", "qwen0.6bemo4-merge/model.safetensors")] },
    { file: "checkpoints/config.yaml", size: 2860, sha256: "18adf417be3e8f5e2e48e30f7420c719170a6870619436250f360d626877870e", sources: [ms("IndexTeam/IndexTTS-2.5", "config.yaml"), hf("IndexTeam/IndexTTS-2.5", "config.yaml")] },
    { file: "checkpoints/feat1.pt", size: 57170, sha256: "f219cb447d80216ba615666da2ff8d63ac544eee26657f3a7b278692bf7a67c4", sources: [ms("IndexTeam/IndexTTS-2.5", "feat1.pt"), hf("IndexTeam/IndexTTS-2.5", "feat1.pt")] },
    { file: "checkpoints/feat2.pt", size: 374866, sha256: "9c4292e96dee535aea9a6206e9a0c856dd578dde9212acdb16dd3ada4d12bf80", sources: [ms("IndexTeam/IndexTTS-2.5", "feat2.pt"), hf("IndexTeam/IndexTTS-2.5", "feat2.pt")] },
    { file: "checkpoints/wav2vec2bert_stats.pt", size: 9343, sha256: "c9c176c2b8850ab2e3ba828bbfa969deaf4566ce55db5f2687b8430b87526ad2", sources: [ms("IndexTeam/IndexTTS-2.5", "wav2vec2bert_stats.pt"), hf("IndexTeam/IndexTTS-2.5", "wav2vec2bert_stats.pt")] },
    { file: "checkpoints/multilingual_zh_ja_yue_char_del.tiktoken", size: 907395, sha256: "747979631e813193436aabcff7c1c235d37de8097b71c563ec8b63b7a515c718", sources: [ms("IndexTeam/IndexTTS-2.5", "multilingual_zh_ja_yue_char_del.tiktoken"), hf("IndexTeam/IndexTTS-2.5", "multilingual_zh_ja_yue_char_del.tiktoken")] },
    // 首跑自拉（indextts/utils/model_download.py）：w2v-bert 4.6GB + bigvgan 449MB + semantic_codec 346MB + campplus 27MB。
    // 预热可省首跑下载等待，但缺失不判 partial——引擎侧 fallback 链实测可用。
    { file: "checkpoints/hf_cache/facebook/w2v-bert-2.0/model.safetensors", size: 4600000000, sha256: "", sources: [hf("facebook/w2v-bert-2.0", "model.safetensors")], tier: "auto" },
    { file: "checkpoints/hf_cache/nvidia/bigvgan_v2_22khz_80band_256x/bigvgan_generator.pt", size: 449000000, sha256: "", sources: [hf("nvidia/bigvgan_v2_22khz_80band_256x", "bigvgan_generator.pt")], tier: "auto" },
    // default 嗓参考（S5）：上游已把示例音频移出版本库改按需下载（repo .gitattributes 注记），
    // 浅克隆不含此件——say 的 default 参考取它，缺了引擎装得齐也出不了 default 声，故进主权重面。
    // 源在 HF Spaces（ModelScope 侧无 models 仓直链形态），单通道 hf-mirror。
    { file: "index-tts/examples/voice_01.wav", size: 478050, sha256: "e33e6ee0107a1dd58e1d66dd90c13df3d55a8683047cc3d7ea206dad84ed3fc8", sources: [hf("spaces/IndexTeam/IndexTTS-2-Demo", "examples/voice_01.wav")] },
  ],
  patches: [],
};

/**
 * FireRedTTS3：指令控制面最全（裁决 3）；上游三层硬编码 CUDA 须 4 处机械 patch（报告「设备路径」节，
 * 默认行为不变：设备行走 FIRERED_DEVICE env 参数化，flash_attention_2 → sdpa——核心类 _supports_sdpa=True 有官方依据）。
 * 权重 20.8GB F32 双变体不共享文件，必须全下。
 */
const FIRERED = {
  id: "firered",
  repo: "https://github.com/FireRedTeam/FireRedTTS3",
  repoDir: "FireRedTTS3",
  python: "3.12",
  deps: {
    /** requirements 剔除三包：flash_attn（CUDA-only 无法编译）、torchcodec/faster-whisper（代码零引用） */
    filterRequirements: { exclude: ["flash_attn", "torchcodec", "faster-whisper"] },
    steps: [{ cmd: ["uv", "pip", "install", "-r", "requirements.min.txt"], cwd: "repo", index: true }],
  },
  weights: [
    { file: "models/FireRedTTS3/fireredtts3_base/model.safetensors", size: 8482608484, sha256: "d6ceed109a04207ef48bc669fb68248d3a44d990fcf2b9641990a6134d2ebb8a", sources: [ms("FireRedTeam/FireRedTTS3", "fireredtts3_base/model.safetensors"), hf("FireRedTeam/FireRedTTS3", "fireredtts3_base/model.safetensors")] },
    { file: "models/FireRedTTS3/fireredtts3_base/config.json", size: 420, sha256: "ebb26c3e8d8105916f66cc9d71433eeef47eb9cdf0c4acfa1fb871658ad45385", sources: [ms("FireRedTeam/FireRedTTS3", "fireredtts3_base/config.json"), hf("FireRedTeam/FireRedTTS3", "fireredtts3_base/config.json")] },
    { file: "models/FireRedTTS3/fireredtts3_instruct/model.safetensors", size: 8475259708, sha256: "a145074153202871f759f52480bbf022bdb70c062a1da90a94b797db8511d889", sources: [ms("FireRedTeam/FireRedTTS3", "fireredtts3_instruct/model.safetensors"), hf("FireRedTeam/FireRedTTS3", "fireredtts3_instruct/model.safetensors")] },
    { file: "models/FireRedTTS3/fireredtts3_instruct/config.json", size: 403, sha256: "722a0b2a074bb898a6e0e99db508e01f36a1a5028c98f2b8b01c1bd48fd194dd", sources: [ms("FireRedTeam/FireRedTTS3", "fireredtts3_instruct/config.json"), hf("FireRedTeam/FireRedTTS3", "fireredtts3_instruct/config.json")] },
    { file: "models/FireRedTTS3/redae/model.safetensors", size: 3775160672, sha256: "0723e87fdaf46d377f01aa32ce56b43f43f9b249415bc8b8f81040eaa8b14abe", sources: [ms("FireRedTeam/FireRedTTS3", "redae/model.safetensors"), hf("FireRedTeam/FireRedTTS3", "redae/model.safetensors")] },
    { file: "models/FireRedTTS3/redae/config.json", size: 853, sha256: "45156fe59707544c66d6a6f855840c39fbf3675420d3ee1bc385c2120722213c", sources: [ms("FireRedTeam/FireRedTTS3", "redae/config.json"), hf("FireRedTeam/FireRedTTS3", "redae/config.json")] },
    { file: "models/FireRedTTS3/campp/campplus_voxceleb.bin", size: 29357703, sha256: "5b1a88b6f8d85826fabef804779c3372b42f3af21457fa48bd5c097c0686b2de", sources: [ms("FireRedTeam/FireRedTTS3", "campp/campplus_voxceleb.bin"), hf("FireRedTeam/FireRedTTS3", "campp/campplus_voxceleb.bin")] },
    { file: "models/FireRedTTS3/text_tokenizer/tokenizer.json", size: 11422654, sha256: "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4", sources: [ms("FireRedTeam/FireRedTTS3", "text_tokenizer/tokenizer.json"), hf("FireRedTeam/FireRedTTS3", "text_tokenizer/tokenizer.json")] },
    { file: "models/FireRedTTS3/text_tokenizer/tokenizer_config.json", size: 9732, sha256: "d5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101", sources: [ms("FireRedTeam/FireRedTTS3", "text_tokenizer/tokenizer_config.json"), hf("FireRedTeam/FireRedTTS3", "text_tokenizer/tokenizer_config.json")] },
    { file: "models/FireRedTTS3/text_tokenizer/vocab.json", size: 2776833, sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910", sources: [ms("FireRedTeam/FireRedTTS3", "text_tokenizer/vocab.json"), hf("FireRedTeam/FireRedTTS3", "text_tokenizer/vocab.json")] },
    // default 嗓参考（S6）：FireRed 引擎无内置示例，取 v1 官方女声 prompt_2（调研 zh_clone 样音同源参考，
    // zh/en 克隆共用同一参考，转写钉在 src/engines/firered.ts DEFAULT_PROMPT_TEXT）。
    // v1 仓此件只在 GitHub examples 分发（ModelScope/HF 仓无）：raw 直连上海网络实测超时，
    // jsdelivr CDN 直连可达且 sha256 一致，双通道互为 fallback。
    { file: "prompts/prompt_2.wav", size: 270694, sha256: "113ac84c15ba60b9629abd5e1c43c51b15616ced2fa987d65bdf3d9d6bdb5211", sources: [{ net: "github", url: "https://raw.githubusercontent.com/FireRedTeam/FireRedTTS/main/examples/prompt_2.wav" }, { net: "jsdelivr", url: "https://cdn.jsdelivr.net/gh/FireRedTeam/FireRedTTS@main/examples/prompt_2.wav" }] },
  ],
  patches: [
    {
      file: "fireredtts3/llm/fireredtts3_base.py",
      ensureImport: "os",
      find: "self.device = torch.device('cuda')",
      replace: "self.device = torch.device(os.environ.get('FIRERED_DEVICE', 'cuda'))",
      why: "Base 类设备行硬编码 cuda，参数化后 MPS/CPU 经 FIRERED_DEVICE 选择，缺省保留上游行为",
    },
    {
      file: "fireredtts3/llm/fireredtts3_instruct.py",
      ensureImport: "os",
      find: "self.device = torch.device('cuda')",
      replace: "self.device = torch.device(os.environ.get('FIRERED_DEVICE', 'cuda'))",
      why: "Instruct 类同款设备行",
    },
    {
      file: "fireredtts3/redae/redae.py",
      find: "attn_implementation='flash_attention_2'",
      replace: "attn_implementation='sdpa'",
      why: "Qwen3Config 构造期两处（redae.py:37,122）钉 flash_attention_2，无 flash_attn 包时构造即抛错；sdpa 回退有 _supports_sdpa=True 依据",
    },
    {
      file: "fireredtts3/llm/fireredtts3_base.py",
      find: '"attn_implementation": "flash_attention_2"',
      replace: '"attn_implementation": "sdpa"',
      why: "Qwen3-1.7B config 字典（base.py:49，Instruct 复用）同款 attn 钉死",
    },
  ],
};

export const ENGINES = { gptsovits: GPTSOVITS, voxcpm: VOXCPM, indextts: INDEXTTS, firered: FIRERED };

export const ENGINE_IDS = Object.keys(ENGINES);
