/** 跨模块共享的领域契约。集中一处避免 engines 桶与 speak 之间的类型循环引用。 */

export type EnvMap = Readonly<Record<string, string | undefined>>;

export interface SayPaths {
  configFile: string;
  modelsDir: string;
  voicesDir: string;
}

/**
 * 一次合成的产出形态。形态决定了上层还要做什么：
 * file 已由引擎写好（上层只负责改名），device 已由引擎直接送出声卡，
 * pcm 是裸样本（上层负责封容器、写盘与播放）。
 */
export type AudioOut =
  | { type: "file"; path: string }
  | { type: "device" }
  | { type: "pcm"; samples: Float32Array; sampleRate: number };

export type Availability = { ok: true } | { ok: false; reason: string };

export interface VoiceInfo {
  name: string;
  engine: string;
  /** 音色天然携带的语言倾向，供上层做语言路由或列举分组 */
  lang: "en" | "zh" | "multi";
}

export interface SpeakOptions {
  /** 引擎内的音色标识；null 表示用该引擎的默认嗓 */
  voice: string | null;
  /** 用户面语速，单位 wpm。单位换算归各引擎，避免三层配置出现两种口径 */
  rateWpm: number;
  /**
   * 非空即要求写入该路径（上层给的是 PID 临时名，不是最终目标）。
   * 只是给「能自己写盘」的引擎的提示：进程内引擎一律返回 pcm，
   * 临时名与原子改名的生命周期归编排层，引擎不该知道 PID 命名规则。
   */
  output: string | null;
}

/** 引擎适配器：注册表以 name 索引，登记即接线 */
export interface EngineAdapter {
  readonly name: string;
  /**
   * 引擎能否把产出交回编排层拼接。分块只对这样的引擎有意义：
   * 进程内推理返回裸样本，块与块可以拼成一段连续音频，也能边合成边播；
   * 自己写盘或直推声卡的引擎，块与块之间无从拼接，切开只会多出边界停顿。
   */
  readonly chunkable: boolean;
  /**
   * 音色名仲裁的可选能力位：引擎声明自己认识哪些音色名。
   * 音色空间分三块——引擎内嵌表（kokoro 103 嗓）、角色克隆嗓（目录即注册表）、
   * 系统嗓开放集（不可枚举成本内）。路由仲裁用认领结果定归属，
   * 谁都不认领的名字走配置引擎报「未登记」再触发回退。
   */
  ownsVoice?(voice: string): boolean;
  /**
   * 可用性按待用音色判定，而不是按引擎整体判定：一个引擎可以挂多套权重，
   * 只装了其中一套时，点名另一套的音色该报「那套缺什么」，
   * 而用已装那套的音色应当照常出声，不能被无关资产连坐。
   * 引擎认不出的音色名不在这层判死，留给 speak 报精确原因。
   */
  isAvailable(voice: string | null): Promise<Availability>;
  listVoices(): Promise<VoiceInfo[]>;
  speak(text: string, opts: SpeakOptions): Promise<AudioOut>;
}

/** 执行器三态：进程拓扑维度的扩展点，换拓扑不改编排 */
export type ExecutorKind = "in-process" | "subprocess" | "daemon";

export interface SynthTask {
  text: string;
  voice: string | null;
  rateWpm: number;
  output: string | null;
}

export interface SynthesisExecutor {
  readonly kind: ExecutorKind;
  synthesize(task: SynthTask): Promise<AudioOut>;
}

/** 配置文件读出的原始值：类型校验推迟到 resolveConfig，语法与语义两层各自可独立测 */
export interface ConfigFile {
  engine?: unknown;
  voice?: unknown;
  speed?: unknown;
  fallback?: unknown;
  /** 预设选择键：本文件声明的默认预设名 */
  preset?: unknown;
  /** `[presets.<name>]` 分节原样：音色×语速×引擎组合表，类型校验在 resolveConfig */
  presets?: unknown;
}

export interface FlagOverrides {
  voice?: string | null;
  rateWpm?: number | null;
  /** 自研 flag，不走 macOS say 透传 */
  preset?: string | null;
  /** 自研 flag：逐次调用的引擎切换，层级在 SAY_ENGINE 与 config 之上 */
  engine?: string | null;
}

export type FallbackPolicy = "system" | "off";

export interface ResolvedConfig {
  engine: string;
  voice: string | null;
  rateWpm: number;
  fallback: FallbackPolicy;
  debug: boolean;
}

export interface ConfigResolution {
  config: ResolvedConfig;
  /** 环境层坏值的降级说明。返回而非直接打印，保持解析纯函数可测 */
  warnings: string[];
  /**
   * 胜出 voice 是 "default" 关键字且调用方未传 locale。门控即解析器：
   * 调用方据此决定是否做 locale 探测，探测后用真实 locale 重解析一遍——
   * 关键字可能来自任意层（含预设），调用方自己扫描层源必然与解析器漂移。
   */
  needsLocale: boolean;
}
