<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{ engines: string[]; voices: string[] }>();

const text = ref("你好，我是你的说话代理。");
const engine = ref("");
const voice = ref("");
const busy = ref(false);
const error = ref("");
const attribution = ref<{ engine: string; daemon: string; totalMs: string; fallback: boolean } | null>(null);
const audioUrl = ref("");

const canSubmit = computed(() => text.value.trim() !== "" && !busy.value);

const submit = async () => {
  if (!canSubmit.value) return;
  busy.value = true;
  error.value = "";
  attribution.value = null;
  if (audioUrl.value) URL.revokeObjectURL(audioUrl.value);
  audioUrl.value = "";
  try {
    const res = await $fetch.raw<Blob>("/api/synthesize", {
      method: "POST",
      body: { text: text.value, engine: engine.value || undefined, voice: voice.value || undefined },
      responseType: "blob",
    });
    attribution.value = {
      engine: res.headers.get("x-say-engine") ?? "unknown",
      daemon: res.headers.get("x-say-daemon") ?? "",
      totalMs: res.headers.get("x-say-total-ms") ?? "",
      fallback: res.headers.get("x-say-fallback") === "1",
    };
    audioUrl.value = URL.createObjectURL(res._data);
  } catch (e) {
    error.value = `合成失败: ${(e as Error).message}`;
  } finally {
    busy.value = false;
  }
};
</script>

<template>
  <section data-testid="synth-console" class="console">
    <h2>活体合成</h2>
    <textarea
      v-model="text"
      data-testid="synth-text"
      rows="3"
      placeholder="输入任意文本，经真实引擎现场合成"
    />
    <div class="controls">
      <label>
        引擎
        <select v-model="engine" data-testid="synth-engine">
          <option value="">默认链</option>
          <option v-for="e in props.engines" :key="e" :value="e">{{ e }}</option>
        </select>
      </label>
      <label>
        嗓位
        <input v-model="voice" data-testid="synth-voice" list="synth-voices" placeholder="default" />
        <datalist id="synth-voices">
          <option v-for="v in props.voices" :key="v" :value="v" />
        </datalist>
      </label>
      <button data-testid="synth-submit" :disabled="!canSubmit" @click="submit">
        {{ busy ? "合成中…" : "合成试听" }}
      </button>
    </div>
    <p v-if="error" class="error" data-testid="synth-error">{{ error }}</p>
    <p v-if="attribution" class="attribution" data-testid="synth-attribution">
      engine={{ attribution.engine }}<template v-if="attribution.daemon"> daemon={{ attribution.daemon }}</template>
      total={{ attribution.totalMs }}ms<template v-if="attribution.fallback">（经回退）</template>
    </p>
    <audio v-if="audioUrl" :src="audioUrl" controls data-testid="synth-audio" />
  </section>
</template>

<style scoped>
.console {
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 10px;
  padding: 0.8rem 1rem;
  margin-top: 2rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
h2 {
  margin: 0;
  font-size: 1.1rem;
  border-bottom: none;
}
textarea {
  font: inherit;
  padding: 0.4rem;
}
.controls {
  display: flex;
  gap: 1rem;
  align-items: center;
  flex-wrap: wrap;
}
.controls label {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}
button {
  cursor: pointer;
}
button:disabled {
  cursor: wait;
  opacity: 0.6;
}
.error {
  color: #e0533d;
}
.attribution {
  color: gray;
  font-size: 0.85rem;
}
audio {
  width: 100%;
  max-width: 40rem;
}
</style>
