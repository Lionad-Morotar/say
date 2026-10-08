/**
 * int16 PCM 有效性判定（真机验收套件的共享校验器，S4 设计、S5 提取为独立模块）。
 *
 * 判据按「代理信号守门」教训设计：时长/体积挡不住等长的静音或噪声，能量项（rms）
 * 与削波连续段才是有效性的本体；NaN 语义在 int16 编码后不可见（引擎在 float 域
 * 出 NaN 会经 astype 变垃圾样本），其代理形态——全零静音与满幅乱跳——被能量/削波
 * 两项覆盖。校验器本身有负例测试（indextts-fastload-acceptance.test.ts 的守门面），
 * 注入假产物证明它会变红，否则守门形同虚设。
 */

export interface PcmVerdict {
  ok: boolean;
  defect?: string;
  rms: number;
  longestClipRun: number;
  durationS: number;
}

/**
 * int16 PCM 有效性判定：时长下限、能量窗、满幅削波连续段上限。
 * 能量窗下沿 200（票 01 实测 rms 3375-3472 的两个数量级之下，挡静音）；
 * 上沿 20000（满幅 32767 的 61%，挡饱和乱跳）；削波连续段 16 样本 ≈ 0.7ms@22050，
 * 正常语音包络不会连续贴满幅这么久。
 */
export function assessPcm(pcm: Int16Array, sampleRate: number): PcmVerdict {
  const durationS = pcm.length / sampleRate;
  if (durationS < 0.5) {
    return { ok: false, defect: `时长 ${durationS.toFixed(2)}s 不足 0.5s`, rms: 0, longestClipRun: 0, durationS };
  }
  let sumSq = 0;
  let clipRun = 0;
  let longestClipRun = 0;
  for (const v of pcm) {
    sumSq += v * v;
    if (Math.abs(v) >= 32767) {
      clipRun += 1;
      if (clipRun > longestClipRun) longestClipRun = clipRun;
    } else {
      clipRun = 0;
    }
  }
  const rms = Math.sqrt(sumSq / pcm.length);
  if (rms < 200) {
    return { ok: false, defect: `rms ${rms.toFixed(0)} 低于 200（静音或退化产物）`, rms, longestClipRun, durationS };
  }
  if (rms > 20000) {
    return { ok: false, defect: `rms ${rms.toFixed(0)} 超 20000（饱和异常）`, rms, longestClipRun, durationS };
  }
  if (longestClipRun >= 16) {
    return { ok: false, defect: `满幅削波连续 ${longestClipRun} 样本`, rms, longestClipRun, durationS };
  }
  return { ok: true, rms, longestClipRun, durationS };
}
