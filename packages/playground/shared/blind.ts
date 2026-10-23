/** 盲态播放位（first/second/tie）映射回真实源（a/b/tie）——app 与 server 共用的纯函数，无 node 依赖 */
export function orderChoiceToSource(
  order: "ab" | "ba",
  playChoice: "first" | "second" | "tie",
): "a" | "b" | "tie" {
  if (playChoice === "tie") return "tie";
  if (order === "ab") return playChoice === "first" ? "a" : "b";
  return playChoice === "first" ? "b" : "a";
}
