<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { AuditionManifest, AuditionSummary, PlayingCell } from "../../server/lib/auditions.ts";

useHead({ title: "say 嗓音工作台" });

const summaries = ref<AuditionSummary[]>([]);
const manifest = ref<AuditionManifest | null>(null);
const currentCell = ref<PlayingCell | null>(null);
const loading = ref(true);
const loadError = ref("");

/** 附表列序由 fields 常量锁定，单元格按 key 取值，不随 manifest JSON 书写序漂移 */
const genderFields = [
  { key: "voice", head: "嗓位" },
  { key: "gender", head: "性别" },
  { key: "basis", head: "依据" },
  { key: "source", head: "音源与处理" },
] as const;
const propFields = [
  { key: "engine", head: "引擎" },
  { key: "latency", head: "热延迟" },
  { key: "form", head: "形态" },
  { key: "ja", head: "ja 接线" },
  { key: "install", head: "安装" },
] as const;

const activeKey = () =>
  currentCell.value ? `cell-${currentCell.value.engine}-${currentCell.value.locale}-${currentCell.value.voice}` : "";

const pickDate = async (date: string) => {
  loading.value = true;
  currentCell.value = null;
  loadError.value = "";
  try {
    manifest.value = await $fetch<AuditionManifest>(`/api/auditions/${date}`);
  } catch (e) {
    loadError.value = `档期加载失败: ${(e as Error).message}`;
  } finally {
    loading.value = false;
  }
};

onMounted(async () => {
  try {
    summaries.value = await $fetch<AuditionSummary[]>("/api/auditions");
    if (summaries.value.length > 0) await pickDate(summaries.value[0].date);
  } catch (e) {
    loadError.value = `档期列表加载失败: ${(e as Error).message}`;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <main class="page">
    <h1>
      {{ manifest?.title ?? "say 嗓音工作台" }}
      <small v-if="manifest">{{ manifest.edition }}</small>
    </h1>

    <nav v-if="summaries.length > 1" class="dates">
      <label>
        档期
        <select data-testid="date-select" :value="manifest?.date" @change="pickDate(($event.target as HTMLSelectElement).value)">
          <option v-for="s in summaries" :key="s.date" :value="s.date">{{ s.date }}</option>
        </select>
      </label>
    </nav>

    <p v-if="manifest" class="summary">{{ manifest.summary }}</p>
    <p v-if="loadError" class="error" data-testid="load-error">{{ loadError }}</p>
    <p v-if="loading" data-testid="loading">加载中…</p>

    <template v-if="manifest">
      <section v-if="manifest.verdicts.length" data-testid="verdicts">
        <h2>试听裁决默认链</h2>
        <p class="chain">
          <span v-for="v in manifest.verdicts" :key="v.key">
            {{ v.key }} → <code>{{ v.engine }} + {{ v.voice }}</code>
          </span>
        </p>
      </section>

      <section>
        <h2>主矩阵：engine × zh/en/ja × 嗓位</h2>
        <p class="legend">
          <span>▶ 有样音，点击播放</span><span>⚪ 已接线、未出样</span><span>— 不适用</span>
          <span class="fix-word">红框 = 音源修复重采</span><span class="ja-word">紫底 = ja 新增</span>
          <span class="winner-word">绿框 = 试听裁决嗓位</span>
        </p>
        <VoiceMatrix
          :engines="manifest.engines"
          :active-key="activeKey()"
          @play="currentCell = $event"
        />
      </section>

      <MatrixPlayer :cell="currentCell" :date="manifest.date" />

      <section>
        <h2>嗓位性别 × 音源</h2>
        <table>
          <tr><th v-for="f in genderFields" :key="f.key">{{ f.head }}</th></tr>
          <tr v-for="(row, i) in manifest.genderTable" :key="i">
            <td v-for="f in genderFields" :key="f.key">{{ row[f.key] }}</td>
          </tr>
        </table>
      </section>

      <section>
        <h2>引擎属性（延迟 × 形态 × ja × 安装）</h2>
        <table>
          <tr><th v-for="f in propFields" :key="f.key">{{ f.head }}</th></tr>
          <tr v-for="(row, i) in manifest.engineProps" :key="i">
            <td v-for="f in propFields" :key="f.key">{{ row[f.key] }}</td>
          </tr>
        </table>
      </section>

      <section v-if="manifest.fixRecords.length">
        <h2>修复记录</h2>
        <p v-for="(r, i) in manifest.fixRecords" :key="i" class="record fixed">{{ r }}</p>
      </section>

      <section v-if="manifest.openItems.length">
        <h2>未决项</h2>
        <p v-for="(r, i) in manifest.openItems" :key="i" class="record gap">{{ r }}</p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.page {
  font-family: -apple-system, "PingFang SC", sans-serif;
  max-width: 84rem;
  margin: 2rem auto;
  padding: 0 1rem;
  line-height: 1.6;
}
h1 {
  font-size: 1.4rem;
}
h2 {
  font-size: 1.1rem;
  margin-top: 2rem;
  border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  padding-bottom: 0.3rem;
}
.small,
h1 small {
  font-size: 0.85rem;
  color: gray;
}
.summary {
  color: gray;
  font-size: 0.9rem;
}
.legend span {
  margin-right: 1.2rem;
  font-size: 0.9rem;
}
.chain span {
  margin-right: 1.2rem;
}
code {
  background: color-mix(in srgb, currentColor 10%, transparent);
  padding: 0.1rem 0.3rem;
  border-radius: 4px;
}
table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.8rem 0;
}
th,
td {
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  padding: 0.4rem 0.5rem;
  text-align: left;
  vertical-align: top;
}
.record {
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 8px;
  padding: 0.6rem 0.9rem;
  margin: 0.5rem 0;
}
.record.fixed {
  border-color: color-mix(in srgb, #3da85c 50%, transparent);
}
.record.gap {
  border-color: color-mix(in srgb, #e0533d 50%, transparent);
}
.error {
  color: #e0533d;
}
.fix-word {
  color: #e0533d;
}
.ja-word {
  color: #7a5cc6;
}
.winner-word {
  color: #3da85c;
}
</style>
