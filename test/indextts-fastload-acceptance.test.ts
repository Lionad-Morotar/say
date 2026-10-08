import { describe, expect, it } from "vitest";
import { REF_AUDIO, SYNTH, runShimPerCall } from "./indextts-say-lab.ts";
import { assessPcm } from "./pcm-verdict.ts";

/**
 * S4 验收口径的数值断言层：fastload patch 下真引擎整句合成的音频质量核验。
 *
 * 判据按「代理信号守门」教训设计：时长/体积挡不住等长的静音或噪声，能量项（rms）
 * 与削波连续段才是有效性的本体；NaN 语义在 int16 编码后不可见（引擎在 float 域
 * 出 NaN 会经 astype 变垃圾样本），其代理形态——全零静音与满幅乱跳——被能量/削波
 * 两项覆盖。校验器本身有负例测试：注入假产物证明它会变红，否则守门形同虚设。
 *
 * 真机套件门控（SYNTH：venv+torch、主权重件级在场、auto 层在场、参考音频在场，
 * 收集期探活）；缺引擎的机器整组 skip、全量照绿。
 * （S5 起校验器本体在 test/pcm-verdict.ts 共享，负例守门仍在本文件。）
 */

function sinePcm(seconds: number, sampleRate: number, amplitude: number): Int16Array {
  const n = Math.floor(seconds * sampleRate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
  return out;
}

describe("PCM 数值校验器", () => {
  it("正例：1s 正弦 rms 约 2300 判有效", () => {
    const v = assessPcm(sinePcm(1, 22050, 3300), 22050);
    expect(v.ok, v.defect).toBe(true);
    expect(v.rms).toBeGreaterThan(1500);
    expect(v.rms).toBeLessThan(3000);
  });

  it("负例一：等长全零静音必须判退化（时长挡不住的能量项）", () => {
    const v = assessPcm(new Int16Array(22050), 22050);
    expect(v.ok).toBe(false);
    expect(v.defect).toMatch(/静音|退化/);
  });

  it("负例二：超长不足 0.5s 必须拒", () => {
    const v = assessPcm(sinePcm(0.1, 22050, 3300), 22050);
    expect(v.ok).toBe(false);
    expect(v.defect).toMatch(/时长/);
  });

  it("负例三：等长正常能量中嵌入连续满幅段必须判 clip（rms 规则挡不住局部削波）", () => {
    const mixed = sinePcm(1, 22050, 3300);
    for (let i = 8000; i < 8020; i++) mixed[i] = i % 2 === 0 ? 32767 : -32767;
    const v = assessPcm(mixed, 22050);
    expect(v.ok).toBe(false);
    expect(v.defect).toMatch(/削波/);
  });
});

describe("indextts 真合成数值断言（真机门控：fastload 路径整链路）", () => {
  it.skipIf(!SYNTH)(
    "per-call 直驱真实二进制合成 22 字短句：ready 帧在场、done 帧 pcm 数值有效、stderr 有 fastload 自报行",
    async () => {
      const req = { id: 1, text: "热启动验收：这次合成的音频数值必须有效。", ref_audio_path: REF_AUDIO, text_lang: "zh" };
      const run = await runShimPerCall([req], { timeoutMs: 420_000, extraEnv: { HF_HUB_OFFLINE: "1" } });

      const ready = run.frames.find((f) => f.type === "ready");
      expect(ready, `无 ready 帧：stdout=${run.stdout.slice(0, 400)} stderr 尾=${run.stderr.slice(-400)}`).toBeDefined();
      expect(String(ready!.engine)).toBe("indextts");
      // patch 生效以被测运行时自报行为准（取证锚点规范）
      expect(run.stderr, "stderr 应有 fastload applied 自报行").toMatch(/\[fastload\] applied=True/);

      const audio = run.frames.find((f) => f.type === "audio" && f.done === true);
      expect(audio, "无 done 音频帧").toBeDefined();
      expect(run.exitCode).toBe(0);

      const buf = Buffer.from(String(audio!.pcm), "base64");
      // 奇数字节 = 帧损坏：必须响亮失败，禁止 Int16Array 静默截断末字节后带缺尾样本继续判
      expect(buf.byteLength % 2, `pcm 字节数为奇（${buf.byteLength}）：协议帧损坏`).toBe(0);
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
      const sampleRate = Number(audio!.sample_rate); // 协议帧字段为 snake_case（engine-protocol v1）
      expect(sampleRate).toBeGreaterThan(0);
      const v = assessPcm(pcm, sampleRate);
      expect(v.ok, `合成数值退化：${v.defect}（rms=${v.rms.toFixed(0)} dur=${v.durationS.toFixed(2)}s）`).toBe(true);
    },
    460_000,
  );
});
