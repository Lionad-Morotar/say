import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 遮罩发生在文件描述符层，进程内测不到——本进程的 stderr 已经被测试运行器接管，
 * 因此用子进程跑真实脚本，直接观察落到管道上的字节。
 */
const MODULE = fileURLToPath(new URL("../src/stderr.ts", import.meta.url));

function probe(body: string) {
  const script = [
    `import { withStderrMuted } from ${JSON.stringify(MODULE)};`,
    `import { writeSync } from "node:fs";`,
    `process.stderr.write("OUTSIDE-BEFORE\\n");`,
    // OUTSIDE-AFTER 放在 finally：抛错路径也要能证明描述符已恢复，否则断言不到收尾诊断
    `try {`,
    `  const value = await withStderrMuted(async () => {`,
    `    process.stderr.write("INSIDE-JS\\n");`,
    `    writeSync(2, "INSIDE-FD\\n");`,
    `    ${body}`,
    `  });`,
    `  process.stdout.write("RETURN:" + value + "\\n");`,
    `} finally {`,
    `  process.stderr.write("OUTSIDE-AFTER\\n");`,
    `}`,
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
}

describe("withStderrMuted：native 库直写 fd 2 的噪声遮罩", () => {
  it("窗口内 JS 层与 fd 层的写入都被吞掉，窗口外原样可见", () => {
    const result = probe(`return 42;`);
    expect(result.stderr).toContain("OUTSIDE-BEFORE");
    expect(result.stderr).toContain("OUTSIDE-AFTER");
    expect(result.stderr).not.toContain("INSIDE-JS");
    expect(result.stderr).not.toContain("INSIDE-FD");
  });

  it("返回值穿过遮罩原样传出，包装不改变调用语义", () => {
    expect(probe(`return 42;`).stdout).toContain("RETURN:42");
  });

  it("窗口内抛错时仍然恢复 stderr，收尾诊断不至于一起被吞", () => {
    const result = probe(`throw new Error("boom");`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OUTSIDE-AFTER");
    expect(result.stderr).toContain("boom");
    expect(result.stderr).not.toContain("INSIDE-FD");
  });

  it("连续两次遮罩互不干扰，描述符不会越用越偏", () => {
    const script = [
      `import { withStderrMuted } from ${JSON.stringify(MODULE)};`,
      `import { writeSync } from "node:fs";`,
      `for (let i = 0; i < 3; i++) {`,
      `  await withStderrMuted(async () => { writeSync(2, "HIDDEN\\n"); });`,
      `}`,
      `process.stderr.write("STILL-WORKS\\n");`,
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("STILL-WORKS\n");
  });
});
