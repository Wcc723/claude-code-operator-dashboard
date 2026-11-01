<script setup>
// 留言清單：依 frame 分組（html 只有一組「頁面」），每則顯示編號、被點到的元素摘要、可直接改文字、刪除。
// 點編號（或整則的空白處）→ emit focus：ArtifactView 讓畫布平移到那個 frame / 讓頁面捲到那個點；
// 滑過 / 鍵盤 focus → emit hover：html 會在頁面上畫出元素外框。
// 刪除有內容的留言要行內確認（不用 window.confirm）；空白的直接刪。確認區標 data-esc-local：
// ArtifactView 的全域 Esc 會跳過它，讓這裡的 Esc 只取消確認、不關掉整個面板。
import { computed, nextTick, ref } from 'vue';
import { LIMITS, groupComments, isBlank, targetLabel } from '../../stores/artifact-draft.js';

const props = defineProps({
  comments: { type: Array, default: () => [] },
  frames: { type: Array, default: () => [] },   // [{ id, title }]
  activeId: { type: String, default: null },
  readonly: { type: Boolean, default: false },
  hint: { type: String, default: '' },          // 空狀態的說明
});
const emit = defineEmits(['focus', 'hover', 'update-text', 'delete']);

const root = ref(null);
const confirmId = ref(null);

const groups = computed(() => groupComments(props.comments, props.frames));
const showGroupTitles = computed(() => props.frames.length > 1 || groups.value.some((g) => g.frameId == null));

function label(c) {
  return targetLabel(c.target);
}

function onItemClick(e, c) {
  // 在輸入框 / 按鈕上的點擊不算「定位」
  if (e.target.closest('textarea, button')) return;
  emit('focus', c.id);
}

function askDelete(c) {
  if (isBlank(c.text)) {
    emit('delete', c.id);
    return;
  }
  confirmId.value = c.id;
  nextTick(() => root.value?.querySelector(`[data-cancel="${c.id}"]`)?.focus());
}

function cancelDelete(c) {
  confirmId.value = null;
  nextTick(() => root.value?.querySelector(`[data-del="${c.id}"]`)?.focus());
}

function doDelete(c) {
  confirmId.value = null;
  emit('delete', c.id);
  // 焦點移到清單本身，不要掉回 body
  nextTick(() => root.value?.focus({ preventScroll: true }));
}

function onItemKeydown(e, c) {
  if (e.key === 'Escape' && confirmId.value === c.id) {
    e.stopPropagation();
    cancelDelete(c);
  }
}

function autosize(e) {
  const t = e.target;
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight + 2, 200)}px`;
}

function onInput(e, c) {
  emit('update-text', c.id, e.target.value);
  autosize(e);
}
</script>

<template>
  <div ref="root" class="cl" tabindex="-1">
    <p v-if="!comments.length" class="cl-empty">{{ hint || '還沒有留言。' }}</p>

    <section v-for="g in groups" :key="g.frameId ?? '_orphans'" class="cl-group">
      <h4 v-if="showGroupTitles" class="cl-gtitle" :class="{ orphan: g.frameId == null }">
        {{ g.title }} <span class="cl-gcount">{{ g.items.length }}</span>
      </h4>
      <ul class="cl-list">
        <li
          v-for="{ comment: c, n } in g.items"
          :key="c.id"
          class="cl-item"
          :class="{ active: activeId === c.id, blank: !c.text?.trim() }"
          @click="onItemClick($event, c)"
          @mouseenter="emit('hover', c.id)"
          @mouseleave="emit('hover', null)"
          @focusin="emit('hover', c.id)"
          @focusout="emit('hover', null)"
          @keydown="onItemKeydown($event, c)"
        >
          <div class="cl-line">
            <button
              type="button"
              class="cl-n"
              :aria-label="`定位到留言 #${n}`"
              :title="g.frameId ? '在畫面上定位' : '這個版本沒有對應的 frame'"
              :disabled="g.frameId == null"
              @click="emit('focus', c.id)"
            >#{{ n }}</button>
            <span class="cl-target" :title="c.target?.selector || ''">{{ label(c) || '（沒有元素資訊）' }}</span>
            <button
              v-if="!readonly && confirmId !== c.id"
              type="button"
              class="cl-del"
              :data-del="c.id"
              :aria-label="`刪除留言 #${n}`"
              title="刪除"
              @click="askDelete(c)"
            >✕</button>
          </div>

          <p v-if="readonly" class="cl-text">{{ c.text || '（空白）' }}</p>
          <textarea
            v-else
            class="cl-ta"
            rows="2"
            :value="c.text"
            :maxlength="LIMITS.commentText"
            :aria-label="`留言 #${n} 的內容`"
            placeholder="（空白的留言提交時會略過）"
            @input="onInput($event, c)"
            @focus="autosize"
          />

          <div v-if="confirmId === c.id" class="cl-confirm" data-esc-local role="group" :aria-label="`確認刪除留言 #${n}`">
            <span class="cl-q">刪除這則留言？</span>
            <button type="button" class="cl-btn danger" @click="doDelete(c)">刪除</button>
            <button type="button" class="cl-btn" :data-cancel="c.id" @click="cancelDelete(c)">取消</button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.cl {
  outline: none;
  font-size: 13px;
  line-height: 1.45;
  color: var(--bone);
}
.cl-empty {
  margin: 4px 0;
  font-size: 12.5px;
  color: var(--dimmer);
  line-height: 1.6;
}
.cl-group + .cl-group {
  margin-top: 12px;
}
.cl-gtitle {
  margin: 0 0 6px;
  font-family: var(--mono);
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.12em;
  color: var(--amber-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cl-gtitle.orphan { color: var(--dimmer); }
.cl-gcount { color: var(--dimmer); margin-left: 4px; }

.cl-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cl-item {
  padding: 6px 8px 8px;
  border: 1px solid var(--line);
  border-left: 2px solid var(--line-bright);
  background: var(--bg);
  cursor: pointer;
  transition: border-color 100ms;
}
.cl-item:hover { border-color: var(--line-bright); }
.cl-item.active {
  border-color: var(--amber-dim);
  border-left-color: var(--amber);
  box-shadow: inset 0 0 10px var(--amber-glow);
}
.cl-item.blank { border-left-style: dashed; }

.cl-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.cl-n {
  flex: none;
  padding: 0 6px;
  border: none;
  background: var(--amber);
  color: #000;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0;
  line-height: 1.6;
}
.cl-n::before,
.cl-n::after { content: none; }
.cl-n:hover { background: var(--cream); color: #000; box-shadow: none; }
.cl-n:disabled { background: var(--line-bright); color: var(--dim); opacity: 1; }
.cl-target {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--dim);
}
.cl-del {
  flex: none;
  width: 26px;
  height: 24px;
  padding: 0;
  border: none;
  font-size: 12px;
  letter-spacing: 0;
  color: var(--dimmer);
}
.cl-del::before,
.cl-del::after { content: none; }
.cl-del:hover { color: var(--danger); box-shadow: none; }

.cl-text {
  margin: 4px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--cream);
}
.cl-ta {
  display: block;
  width: 100%;
  margin-top: 4px;
  min-height: 40px;
  padding: 4px 8px;
  font-size: 13px;
  resize: none;
  cursor: text;
}

.cl-confirm {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.cl-q {
  flex: 1;
  font-size: 12px;
  color: var(--amber);
}
.cl-btn {
  padding: 1px 8px;
  font-size: 12px;
  letter-spacing: 0.06em;
  text-transform: none;
}
.cl-btn.danger { color: var(--danger); border-color: var(--danger); }
.cl-btn.danger::before,
.cl-btn.danger::after { color: var(--danger); }
.cl-btn.danger:hover { background: var(--danger); color: #000; }

.cl :is(button, textarea):focus-visible {
  outline: 1px solid var(--amber);
  outline-offset: 2px;
}

@media (pointer: coarse) {
  .cl-n { min-height: 32px; min-width: 40px; }
  .cl-del { width: 40px; height: 40px; }
  .cl-btn { min-height: 40px; padding: 0 14px; font-size: 13px; }
  .cl-ta { font-size: 16px; }
}
</style>
