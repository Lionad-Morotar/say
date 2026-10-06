import { describe, expect, it } from "vitest";
import type { SpawnOutcome } from "../src/host.ts";
import { detectLocale } from "../src/locale.ts";
import { createFakeHost, type SpawnRecord } from "./fake-host.ts";

/** AppleLanguages 有值时 defaults 的 plist 形态输出（本机实测样例） */
const ZH_PLIST = '(\n    "zh-Hans-CN",\n    "en-US"\n)\n';

/** fake-host 的 spawnOutcome 是同步回调，throws=true 模拟 defaults 二进制不可达 */
function outcomes(stdout = "", exitCode = 0, throws = false): (record: SpawnRecord) => SpawnOutcome {
  return (record) => {
    if (throws) throw new Error(`ENOENT: ${record.cmd}`);
    return { exitCode, signal: null, stdout, stderr: "" };
  };
}

describe("detectLocale：AppleLanguages 优先、LANG 兜底、缺省 en", () => {
  it("AppleLanguages 的 zh-Hans-CN 归一为 zh，胜过 LANG", async () => {
    const { host } = createFakeHost({ env: { LANG: "en_US.UTF-8" }, spawnOutcome: outcomes(ZH_PLIST) });
    await expect(detectLocale(host)).resolves.toBe("zh");
  });

  it("AppleLanguages 的 en-US 探测为 en", async () => {
    const { host } = createFakeHost({
      spawnOutcome: outcomes('(\n    "en-US",\n    "zh-Hans-CN"\n)\n'),
    });
    await expect(detectLocale(host)).resolves.toBe("en");
  });

  it("defaults 进程失败（非 macOS）落 LANG 兜底", async () => {
    const { host } = createFakeHost({ env: { LANG: "zh_CN.UTF-8" }, spawnOutcome: outcomes("", 0, true) });
    await expect(detectLocale(host)).resolves.toBe("zh");
  });

  it("AppleLanguages 键缺失（stdout 空、exit 1）落 LANG 兜底", async () => {
    const { host } = createFakeHost({ env: { LANG: "en_US.UTF-8" }, spawnOutcome: outcomes("", 1) });
    await expect(detectLocale(host)).resolves.toBe("en");
  });

  it("两环全无落缺省 en", async () => {
    const { host } = createFakeHost({ env: {}, spawnOutcome: outcomes("", 1) });
    await expect(detectLocale(host)).resolves.toBe("en");
  });

  it.each([
    ["zh_CN.UTF-8", "zh"],
    ["C", "en"],
    ["POSIX", "en"],
    ["fr_FR.UTF-8", "en"],
  ])("LANG %s 归一为 %s", async (lang, expected) => {
    const { host } = createFakeHost({ env: { LANG: lang }, spawnOutcome: outcomes("", 1) });
    await expect(detectLocale(host)).resolves.toBe(expected);
  });

  it("yue 粤语主标签按一期近似落 en", async () => {
    const { host } = createFakeHost({ spawnOutcome: outcomes('(\n    "yue-Hant-HK"\n)\n') });
    await expect(detectLocale(host)).resolves.toBe("en");
  });

  it("LANG 为空串视同未设，落缺省 en", async () => {
    const { host } = createFakeHost({ env: { LANG: "" }, spawnOutcome: outcomes("", 1) });
    await expect(detectLocale(host)).resolves.toBe("en");
  });
});

