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
}

export interface FlagOverrides {
  voice?: string | null;
  rateWpm?: number | null;
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
}
