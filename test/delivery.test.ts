import { describe, expect, it } from "vitest";
import { deliver, startTiming, stagingPath } from "../src/delivery.ts";
import { AFPLAY_BIN } from "../src/player.ts";
import type { AudioOut } from "../src/types.ts";
import { createFakeHost } from "./fake-host.ts";

const TMP = "/var/tmp";

function setup(pid = 4242) {
  const fake = createFakeHost({ tmpDir: TMP, pid });
  return { fake, host: fake.host, timing: startTiming(fake.host) };
}

const pcm = (length = 3): AudioOut => ({
  type: "pcm",
  samples: new Float32Array(length).fill(0.1),
  sampleRate: 24000,
});

describe("deliver：三种产出形态到两种交付去向", () => {
  it("pcm 落盘走 PID 临时名再原子改名", async () => {
    const { host, timing, fake } = setup(77);
    const result = await deliver(host, pcm(), { target: "/out/a.wav", temp: "/out/a.wav.77.tmp", staging: "" }, timing);
    expect(result.delivered).toBe(true);
    expect(fake.writes[0]?.path).toBe("/out/a.wav.77.tmp");
    expect(fake.renames).toEqual([{ from: "/out/a.wav.77.tmp", to: "/out/a.wav" }]);
    expect(fake.spawns).toHaveLength(0);
  });

  it("pcm 出声卡走暂存 wav、afplay、播完即删", async () => {
    const { host, timing, fake } = setup(77);
    const staging = stagingPath(host, null);
    const result = await deliver(host, pcm(), { target: null, temp: null, staging }, timing);
    expect(result.delivered).toBe(true);
    expect(fake.writes[0]?.path).toBe(`${TMP}/say-77.wav`);
    expect(fake.spawns).toEqual([{ cmd: AFPLAY_BIN, args: [`${TMP}/say-77.wav`], stdin: undefined }]);
    expect(fake.removes).toEqual([`${TMP}/say-77.wav`]);
  });

  it("分块暂存名带块序号，下一块不会截断上一块正在播的文件", () => {
    const { host } = setup(77);
    expect(stagingPath(host, null)).toBe(`${TMP}/say-77.wav`);
    expect(stagingPath(host, 0)).toBe(`${TMP}/say-77-0.wav`);
    expect(stagingPath(host, 3)).toBe(`${TMP}/say-77-3.wav`);
  });

  it("device 已经出过声，交付层无事可做", async () => {
    const { host, timing, fake } = setup();
    const result = await deliver(host, { type: "device" }, { target: null, temp: null, staging: "" }, timing);
    expect(result.delivered).toBe(true);
    expect(fake.spawns).toHaveLength(0);
  });

  it("file 与目标不同名时改名过去", async () => {
    const { host, timing, fake } = setup(77);
    const result = await deliver(
      host,
      { type: "file", path: "/out/a.wav.77.tmp" },
      { target: "/out/a.wav", temp: "/out/a.wav.77.tmp", staging: "" },
      timing,
    );
    expect(result.delivered).toBe(true);
    expect(fake.renames).toEqual([{ from: "/out/a.wav.77.tmp", to: "/out/a.wav" }]);
  });

  it("file 已经在目标名上时不必改名", async () => {
    const { host, timing, fake } = setup();
    const result = await deliver(
      host,
      { type: "file", path: "/out/a.wav" },
      { target: "/out/a.wav", temp: "/out/a.wav.4242.tmp", staging: "" },
      timing,
    );
    expect(result.delivered).toBe(true);
    expect(fake.renames).toHaveLength(0);
  });

  it("要出声卡却只拿到一个文件时按失败处理：没人播它，exit 0 会是无声的成功", async () => {
    const { host, timing, fake } = setup();
    const result = await deliver(
      host,
      { type: "file", path: "/out/ignored.wav" },
      { target: null, temp: null, staging: "" },
      timing,
    );
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("/out/ignored.wav");
    expect(fake.spawns).toHaveLength(0);
  });
});
