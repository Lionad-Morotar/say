<script setup lang="ts">
import { ref, watch } from "vue";
import type { PlayingCell } from "../../server/lib/auditions.ts";

const props = defineProps<{ cell: PlayingCell | null; date: string }>();
const audioEl = ref<HTMLAudioElement | null>(null);

watch(
  () => props.cell,
  (cell) => {
    if (!cell || !audioEl.value) return;
    audioEl.value.playbackRate = 1;
    // autoplay 策略拒绝（如自动化环境无 user activation）时静默，
    // 用户经原生 controls 手动播放即可，不产生 unhandled rejection
    audioEl.value.play().catch(() => {});
  },
  // flush post：等 v-if 的 audio 挂载与 src 补丁完成后再触发播放，
  // 默认 pre 时序下首击时元素未挂载、换格时 src 未更新，播放意图两次落空
  { flush: "post" },
);
</script>

<template>
  <div data-testid="matrix-player" class="player">
    <span class="label" data-testid="player-label">
      {{ cell ? cell.audio.split("/").pop() : "点击矩阵中 ▶ 格播放对应样音" }}
    </span>
    <audio
      v-if="cell"
      ref="audioEl"
      :src="`/api/auditions/${props.date}/${cell.audio}`"
      controls
      preload="none"
      data-testid="player-audio"
    />
  </div>
</template>

<style scoped>
.player {
  position: sticky;
  bottom: 0;
  background: color-mix(in srgb, Canvas 92%, transparent);
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 10px;
  padding: 0.6rem 0.9rem;
  margin-top: 1rem;
  backdrop-filter: blur(6px);
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
audio {
  width: 100%;
  max-width: 40rem;
}
.label {
  font-size: 0.8rem;
  color: gray;
}
</style>
