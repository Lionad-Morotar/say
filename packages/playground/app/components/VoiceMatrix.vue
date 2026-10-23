<script setup lang="ts">
import type { EngineRow, MatrixCell, PlayingCell } from "../../server/lib/auditions.ts";

const props = defineProps<{ engines: EngineRow[]; activeKey?: string }>();
const emit = defineEmits<{ play: [cell: PlayingCell] }>();

const columns: { locale: string; voice: string; head: string }[] = [
  { locale: "zh", voice: "default", head: "default" },
  { locale: "zh", voice: "frieren-zh", head: "芙莉莲" },
  { locale: "zh", voice: "dva", head: "D.Va" },
  { locale: "zh", voice: "lucy", head: "Lucy" },
  { locale: "en", voice: "default", head: "default" },
  { locale: "en", voice: "frieren-en", head: "芙莉莲" },
  { locale: "en", voice: "dva", head: "D.Va" },
  { locale: "en", voice: "lucy", head: "Lucy" },
  { locale: "ja", voice: "default", head: "default" },
  { locale: "ja", voice: "frieren", head: "芙莉莲" },
];

const testid = (engine: string, c: MatrixCell) => `cell-${engine}-${c.locale}-${c.voice}`;

/** 表头列序是渲染主驱动：格子按 locale+voice 查找落位，不依赖 manifest cells 数组顺序 */
const rowsOf = (engine: EngineRow): { col: { locale: string; voice: string; head: string }; cell: MatrixCell }[] =>
  columns.map((col) => ({
    col,
    cell:
      engine.cells.find((c) => c.locale === col.locale && c.voice === col.voice) ??
      ({ locale: col.locale, voice: col.voice, kind: "na", flags: [] } as MatrixCell),
  }));

const onPlay = (engine: string, c: MatrixCell) => {
  if (c.kind !== "play") return;
  emit("play", { ...c, engine });
};
</script>

<template>
  <table data-testid="voice-matrix">
    <thead>
      <tr>
        <th rowspan="2">引擎</th>
        <th colspan="4">zh</th>
        <th colspan="4">en</th>
        <th colspan="2">ja</th>
      </tr>
      <tr>
        <th v-for="col in columns" :key="`${col.locale}-${col.voice}`">{{ col.head }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="engine in props.engines" :key="engine.name">
        <td class="engine">
          <b>{{ engine.name }}</b>
          <span class="sub">{{ engine.tag }}</span>
        </td>
        <td
          v-for="{ col, cell } in rowsOf(engine)"
          :key="`${engine.name}-${col.locale}-${col.voice}`"
          :class="[cell.kind, ...cell.flags]"
          :data-testid="testid(engine.name, cell)"
        >
          <button
            v-if="cell.kind === 'play'"
            :class="{ playing: props.activeKey === testid(engine.name, cell) }"
            @click="onPlay(engine.name, cell)"
          >
            {{ cell.label }}
            <span v-if="cell.note" class="sub">{{ cell.note }}</span>
          </button>
          <span v-else-if="cell.kind === 'await'" class="sub">{{ cell.note }}</span>
          <template v-else>—</template>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
table {
  border-collapse: collapse;
  width: 100%;
}
th,
td {
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  padding: 0.4rem 0.5rem;
  text-align: left;
  vertical-align: top;
}
th {
  white-space: nowrap;
}
.engine .sub {
  display: block;
}
.sub {
  font-size: 0.72rem;
  color: gray;
}
td.play {
  padding: 0;
}
td.play button {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  display: block;
  width: 100%;
  padding: 0.4rem 0.5rem;
}
td.play button::before {
  content: "▶ ";
}
td.play button:hover {
  background: color-mix(in srgb, currentColor 8%, transparent);
}
td.play button.playing::before {
  content: "🔊 ";
}
td.na {
  color: gray;
  text-align: center;
}
td.await {
  text-align: center;
}
td.fix {
  outline: 2px solid color-mix(in srgb, #e0533d 55%, transparent);
  outline-offset: -2px;
}
td.ja {
  background: color-mix(in srgb, #7a5cc6 8%, transparent);
}
td.winner {
  outline: 2px solid color-mix(in srgb, #3da85c 70%, transparent);
  outline-offset: -2px;
}
</style>
