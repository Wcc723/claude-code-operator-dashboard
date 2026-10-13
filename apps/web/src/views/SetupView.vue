<script setup>
import SetupGuide from '../components/SetupGuide.vue';
</script>

<template>
  <div class="setup-view">
    <div class="toolbar">
      <h2>SETUP</h2>
    </div>
    <p class="section-meta">CLAUDE CODE · HOOKS + STATUSLINE</p>
    <p class="intro">
      CODD 透過 Claude Code 的 hooks 與 statusLine 取得每個 session 的即時狀態、標題、最近一次 prompt，
      以及目前帳號的 5h/1w 用量。下面會檢查 server 這台主機的設定，你可以先預覽要改的內容，再一鍵安裝或移除。
    </p>
    <SetupGuide />
  </div>
</template>

<style scoped>
.intro {
  max-width: 860px;
  margin: 0 0 20px;
  color: var(--bone);
  font-size: 15px;
  line-height: 1.7;
}
@media (max-width: 767px) {
  .intro { font-size: 14.5px; }
}
</style>
