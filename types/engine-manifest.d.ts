/**
 * scripts/lib/engine-manifest.mjs 的类型声明：该 .mjs 是四引擎安装清单的权威数据源。
 * scripts/ 不在 tsconfig include 内，而 test/ 侧的 marker↔manifest 对拍要读它的 weights，
 * 故此处补最小声明面（只暴露被 TS 侧消费的导出，不复制整份 manifest 形状防双真源）。
 */
declare module "*/engine-manifest.mjs" {
  export interface ManifestWeight {
    /** 相对 engineDir 的落位路径 */
    file: string;
    /** auto = 引擎首跑自拉的隐藏依赖（运行时产物，非安装事件，不进指纹 marker 清单） */
    tier?: "auto";
    /** 存在即归档解压落位（安装成功写 `<file>/.install-ok` marker） */
    archive?: { strip: number; delete?: boolean };
  }
  export interface ManifestEngine {
    id: string;
    repoDir: string;
    weights: ManifestWeight[];
  }
  export const ENGINES: Record<string, ManifestEngine>;
}
