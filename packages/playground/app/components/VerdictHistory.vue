<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { DateVerdicts } from "../../server/lib/verdicts.ts";

const dates = ref<DateVerdicts[]>([]);
const error = ref("");

onMounted(async () => {
  try {
    dates.value = await $fetch<DateVerdicts[]>("/api/verdicts");
  } catch (e) {
    error.value = `历史加载失败: ${(e as Error).message}`;
  }
});

const total = () => dates.value.reduce((n, d) => n + d.sessions.length, 0);
</script>

<template>
  <section data-testid="verdict-history" class="history">
    <h2>盲听裁决历史（{{ total() }} 条）</h2>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="total() === 0" data-testid="verdict-empty">尚无落档裁决，完成一次盲听后在此可见</p>
    <div v-for="d in dates" :key="d.date" class="date-group">
      <h3>{{ d.date }}</h3>
      <table>
        <tr><th>题目</th><th>A</th><th>B</th><th>裁决</th><th>播放序</th><th>备注</th><th>样音</th></tr>
        <tr v-for="s in d.sessions" :key="s.id" :data-testid="`verdict-${s.id}`">
          <td>{{ s.prompt }}</td>
          <td>{{ s.sources.a.engine }}/{{ s.sources.a.voice }}</td>
          <td>{{ s.sources.b.engine }}/{{ s.sources.b.voice }}</td>
          <td>{{ s.choice }}</td>
          <td>{{ s.order }}</td>
          <td>{{ s.note }}</td>
          <td>
            <a :href="`/api/auditions/${d.date}/${s.sources.a.audio}`">A</a>
            <a :href="`/api/auditions/${d.date}/${s.sources.b.audio}`">B</a>
          </td>
        </tr>
      </table>
    </div>
  </section>
</template>

<style scoped>
.history h2 {
  font-size: 1.1rem;
}
.date-group h3 {
  margin: 1rem 0 0.3rem;
  font-size: 1rem;
}
table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.4rem 0;
}
th,
td {
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  padding: 0.3rem 0.5rem;
  text-align: left;
}
td a {
  margin-right: 0.6rem;
}
.error {
  color: #e0533d;
}
</style>
