import { describe, expect, it } from "vitest";
import { PlaybackError } from "../src/errors.ts";
import { AFPLAY_BIN, playFile } from "../src/player.ts";
import { createFakeHost } from "./fake-host.ts";

describe("playFile：afplay 出声", () => {
  it("把文件路径作为唯一参数交给 afplay，成功即静默返回", async () => {
    const fake = createFakeHost();
    await expect(playFile(fake.host, "/tmp/a.wav")).resolves.toBeUndefined();
    expect(fake.spawns).toEqual([{ cmd: AFPLAY_BIN, args: ["/tmp/a.wav"], stdin: undefined }]);
  });

  it("afplay 非零退出转为 PlaybackError，并带上它自己的原因", async () => {
    const fake = createFakeHost({
      spawnOutcome: () => ({ exitCode: 1, signal: null, stdout: "", stderr: "AudioFileOpen failed ('typ?')" }),
    });
    await expect(playFile(fake.host, "/tmp/bad.wav")).rejects.toThrow(/AudioFileOpen failed/);
  });

  it("被信号杀死时退出码为 null，仍按失败处理", async () => {
    const fake = createFakeHost({
      spawnOutcome: () => ({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "" }),
    });
    await expect(playFile(fake.host, "/tmp/a.wav")).rejects.toThrow(/SIGKILL/);
  });

  it("抛出的是 PlaybackError 而不是通用 Error，编排层据此区分合成失败与出声失败", async () => {
    const fake = createFakeHost({ exitCode: 1 });
    await expect(playFile(fake.host, "/tmp/a.wav")).rejects.toBeInstanceOf(PlaybackError);
  });

  it("不喂 stdin：afplay 只认文件参数，管道输入会让它挂住", async () => {
    const fake = createFakeHost();
    await playFile(fake.host, "/tmp/a.wav");
    expect(fake.spawns[0]?.stdin).toBeUndefined();
  });
});
