审查完成，产物已写入 `docs/reports/261007/review-engine-v2-voice-matrix.md`。

**共 4 条高/中严重度事实错误**（+1 条附带数字勘误）：

1. **（高）firered 形态列造假现状**——属性表写「整句 + 指令面（语速/pitch/volume/方言）」，但 `firered.ts` 明说指令面属 Instruct 能力「一期不接」（上游解包 bug 规避，`-r` 被忽略），票 08 另立 backlog。同表其他引擎格都是 adapter 实况，唯独这格把官方能力当接线现状。

2. **（高）firered「20.8GB 已清理」过时且自相矛盾**——磁盘实测 `say-lab/firered/` 在位 39GB，本批 14:14 刚产出 HTML 自己内嵌的 6 段 firered 样音。「已清理」是 S6 前的历史快照；权威报告原文只说「fresh 下载链未重放」。

3. **（高）「男声仅 system 开放集可达」为假**——sherpa 内嵌表有 45 个 `zm_*` 中文男声（`sherpa-voices.ts:29-37`，sid 58-102），`-e sherpa -v zm_009` 即刻可用。

4. **（中）default 维「其余引擎内置说话人」失实**——voxcpm default 是文本指令嗓（voice creation），firered default 是**女声**参考 prompt_2 克隆；配套简报自己的措辞都与之相左。

其余核对项（24 样音、默认链、zipvoice 不适用 default、lucy 四引擎认领、延迟/体积数字、三角色 meta、ja 票 09 状态）均与权威源一致。
