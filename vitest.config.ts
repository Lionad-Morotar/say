import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // 单测不得触碰真实模型资产与用户配置：任何用例若走到 ~/.cache/say 或 ~/.config/say 即视为接缝泄漏
    env: { HOME: "/nonexistent-say-test-home" },
  },
});
