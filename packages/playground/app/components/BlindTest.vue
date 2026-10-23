<script setup lang="ts">
import { computed, ref } from "vue";
import { orderChoiceToSource } from "../../shared/blind.ts";

const props = defineProps<{ engines: string[]; voices: string[] }>();
const emit = defineEmits<{ saved: [] }>();

const prompt = ref("这句用来盲听对比，两边引擎谁更自然？");
const engineA = ref("");
const voiceA = ref("");
const engineB = ref("");
const voiceB = ref("");

const phase = ref<"idle" | "synthesizing" | "blind" | "revealed">("idle");
const order = ref<"ab" | "ba">("ab");
const error = ref("");
const savedId = ref("");
const note = ref("");
const audioFirst = ref("");
const audioSecond = ref("");

/** 合成时点快照：落档与揭盲一律读快照，杜绝盲听途中改配置让证据与音频脱节 */
let snapshot = {
  prompt: "",
  a: { engine: "", voice: "", servedEngine: "" },
  b: { engine: "", voice: "", servedEngine: "" },
};
let bytesA = new Uint8Array();
let bytesB = new Uint8Array();
let pendingChoice: "a" | "b" | "tie" | null = null;

const canStart = computed(
  () => prompt.value.trim() !== "" && phase.value === "idle" && engineA.value !== "" && engineB.value !== "",
);
const formLocked = computed(() => phase.value !== "idle");

const synthesizeOne = async (engine: string, voice: string) => {
  const res = await $fetch.raw<Blob>("/api/synthesize", {
    method: "POST",
    body: { text: prompt.value, engine, voice: voice || undefined },
    responseType: "blob",
  });
  return {
    blob: res._data,
    servedEngine: res.headers.get("x-say-engine") ?? engine,
    fallback: res.headers.get("x-say-fallback") === "1",
  };
};

const start = async () => {
  if (!canStart.value) return;
  phase.value = "synthesizing";
  error.value = "";
  savedId.value = "";
  try {
    const [ra, rb] = await Promise.all([
      synthesizeOne(engineA.value, voiceA.value),
      synthesizeOne(engineB.value, voiceB.value),
    ]);
    bytesA = new Uint8Array(await ra.blob.arrayBuffer());
    bytesB = new Uint8Array(await rb.blob.arrayBuffer());
    // 归因取实际服务引擎（回退后可能是 system），证据不冒充用户所选
    snapshot = {
      prompt: prompt.value,
      a: { engine: ra.servedEngine, voice: voiceA.value || "default", servedEngine: ra.servedEngine },
      b: { engine: rb.servedEngine, voice: voiceB.value || "default", servedEngine: rb.servedEngine },
    };
    order.value = Math.random() < 0.5 ? "ab" : "ba";
    const first = order.value === "ab" ? bytesA : bytesB;
    const second = order.value === "ab" ? bytesB : bytesA;
    audioFirst.value = URL.createObjectURL(new Blob([first], { type: "audio/wav" }));
    audioSecond.value = URL.createObjectURL(new Blob([second], { type: "audio/wav" }));
    pendingChoice = null;
    phase.value = "blind";
  } catch (e) {
    error.value = `合成失败: ${(e as Error).message}`;
    phase.value = "idle";
  }
};

const toB64 = (u8: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

const submitVerdict = async (choice: "a" | "b" | "tie") => {
  const res = await $fetch<{ date: string; session: { id: string } }>("/api/verdicts", {
    method: "POST",
    body: {
      prompt: snapshot.prompt,
      a: { engine: snapshot.a.engine, voice: snapshot.a.voice, wavB64: toB64(bytesA) },
      b: { engine: snapshot.b.engine, voice: snapshot.b.voice, wavB64: toB64(bytesB) },
      order: order.value,
      choice,
      note: note.value,
    },
  });
  savedId.value = res.session.id;
  emit("saved");
};

const choose = async (playChoice: "first" | "second" | "tie") => {
  pendingChoice = orderChoiceToSource(order.value, playChoice);
  phase.value = "revealed";
  try {
    await submitVerdict(pendingChoice);
  } catch (e) {
    // 裁决不丢：盲选已定格，重试按钮兜底补落档
    error.value = `落档失败: ${(e as Error).message}`;
  }
};

const retrySave = async () => {
  if (pendingChoice === null) return;
  error.value = "";
  try {
    await submitVerdict(pendingChoice);
  } catch (e) {
    error.value = `落档失败: ${(e as Error).message}`;
  }
};

const reset = () => {
  phase.value = "idle";
  error.value = "";
  savedId.value = "";
  pendingChoice = null;
};

const revealText = computed(() => {
  if (phase.value !== "revealed" && phase.value !== "blind") return "";
  const first = order.value === "ab" ? snapshot.a : snapshot.b;
  const second = order.value === "ab" ? snapshot.b : snapshot.a;
  return `先播 = ${first.engine}/${first.voice}，后播 = ${second.engine}/${second.voice}`;
});
</script>

<template>
  <section data-testid="blind-test" class="blind">
    <h2>盲听裁决</h2>
    <div class="sources">
      <label>
        源 A
        <select v-model="engineA" data-testid="blind-engine-a" :disabled="formLocked">
          <option value="" disabled>选引擎</option>
          <option v-for="e in props.engines" :key="e" :value="e">{{ e }}</option>
        </select>
        <input v-model="voiceA" data-testid="blind-voice-a" list="blind-voices" placeholder="voice" :disabled="formLocked" />
      </label>
      <label>
        源 B
        <select v-model="engineB" data-testid="blind-engine-b" :disabled="formLocked">
          <option value="" disabled>选引擎</option>
          <option v-for="e in props.engines" :key="e" :value="e">{{ e }}</option>
        </select>
        <input v-model="voiceB" data-testid="blind-voice-b" list="blind-voices" placeholder="voice" :disabled="formLocked" />
      </label>
      <datalist id="blind-voices">
        <option v-for="v in props.voices" :key="v" :value="v" />
      </datalist>
    </div>
    <textarea v-model="prompt" rows="2" data-testid="blind-prompt" :disabled="formLocked" />
    <button data-testid="blind-start" :disabled="!canStart" @click="start">
      {{ phase === "synthesizing" ? "合成中…" : "合成并盲听" }}
    </button>

    <div v-if="phase === 'blind'" class="blindplay" data-testid="blind-play">
      <p>随机序已定，先听「甲」再听「乙」，然后盲选：</p>
      <figure>
        <figcaption>甲</figcaption>
        <audio :src="audioFirst" controls />
      </figure>
      <figure>
        <figcaption>乙</figcaption>
        <audio :src="audioSecond" controls />
      </figure>
      <input v-model="note" data-testid="blind-note" placeholder="裁决备注（可选，落档前可填）" />
      <div class="choices">
        <button data-testid="blind-pick-first" @click="choose('first')">甲更优</button>
        <button data-testid="blind-pick-second" @click="choose('second')">乙更优</button>
        <button data-testid="blind-pick-tie" @click="choose('tie')">难分伯仲</button>
      </div>
    </div>

    <div v-if="phase === 'revealed'" class="revealed" data-testid="blind-reveal">
      <p>{{ revealText }}
        <template v-if="savedId">已落档 {{ savedId }}</template>
      </p>
      <div class="actions">
        <button v-if="!savedId" data-testid="blind-retry" @click="retrySave">重试落档</button>
        <button data-testid="blind-again" @click="reset">再来一轮</button>
      </div>
    </div>
    <p v-if="error" class="error" data-testid="blind-error">{{ error }}</p>
  </section>
</template>

<style scoped>
.blind {
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
}
.sources {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}
.sources label {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}
textarea,
input {
  font: inherit;
  padding: 0.4rem;
}
.blindplay {
  border-top: 1px dashed color-mix(in srgb, currentColor 25%, transparent);
  padding-top: 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
figure {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
figcaption {
  font-weight: 600;
}
.choices,
.actions {
  display: flex;
  gap: 0.8rem;
}
.revealed {
  color: #3da85c;
}
.revealed p {
  margin: 0 0 0.4rem;
}
.error {
  color: #e0533d;
}
</style>
