const targetContainer = document.getElementById("targets");
const addForm = document.getElementById("add-form");
const urlInput = document.getElementById("url-input");
const refreshAllButton = document.getElementById("refresh-all");
const historySelect = document.getElementById("history-target");
const historyContainer = document.getElementById("history");
const intervalInput = document.getElementById("interval");
const toggleAutoButton = document.getElementById("toggle-auto");

const state = {
  targets: [],
  autoTimer: null
};

const formatTimestamp = (value) => {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  return date.toLocaleString();
};

const renderTargets = () => {
  targetContainer.innerHTML = "";
  const template = document.getElementById("target-template");

  if (state.targets.length === 0) {
    targetContainer.innerHTML = "<p class=\"empty\">まだ登録がありません。</p>";
    return;
  }

  state.targets.forEach((target) => {
    const node = template.content.cloneNode(true);
    const urlElement = node.querySelector(".target-url");
    const metaElement = node.querySelector(".target-meta");
    const checkButton = node.querySelector(".check");

    urlElement.textContent = target.url;
    metaElement.textContent = `最終チェック: ${formatTimestamp(target.lastCheckedAt)} / 変更検知: ${formatTimestamp(target.lastChangedAt)} / 状態: ${target.status}`;

    checkButton.addEventListener("click", async () => {
      await checkTarget(target.id);
    });

    targetContainer.appendChild(node);
  });
};

const renderHistoryOptions = () => {
  historySelect.innerHTML = "";
  state.targets.forEach((target) => {
    const option = document.createElement("option");
    option.value = target.id;
    option.textContent = target.url;
    historySelect.appendChild(option);
  });
};

const renderHistory = (entries) => {
  historyContainer.innerHTML = "";
  const template = document.getElementById("history-template");

  if (entries.length === 0) {
    historyContainer.innerHTML = "<p class=\"empty\">履歴がまだありません。</p>";
    return;
  }

  entries
    .slice()
    .reverse()
    .forEach((entry) => {
      const node = template.content.cloneNode(true);
      const meta = node.querySelector(".history-meta");
      const diff = node.querySelector(".history-diff");

      meta.textContent = `${formatTimestamp(entry.timestamp)} / 追加 ${entry.summary.added} 行 / 削除 ${entry.summary.removed} 行`;

      diff.innerHTML = entry.diff
        .map((line) => {
          if (line.type === "added") {
            return `<span class=\"diff-added\">+ ${line.text}</span>`;
          }
          if (line.type === "removed") {
            return `<span class=\"diff-removed\">- ${line.text}</span>`;
          }
          return `<span class=\"diff-context\">  ${line.text}</span>`;
        })
        .join("\n");

      historyContainer.appendChild(node);
    });
};

const fetchTargets = async () => {
  const response = await fetch("/api/targets");
  const data = await response.json();
  state.targets = data.targets;
  renderTargets();
  renderHistoryOptions();

  if (state.targets.length > 0) {
    historySelect.value = state.targets[0].id;
    await fetchHistory(state.targets[0].id);
  } else {
    renderHistory([]);
  }
};

const addTarget = async (url) => {
  const response = await fetch("/api/targets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });

  if (!response.ok) {
    const error = await response.json();
    alert(error.error || "登録に失敗しました");
    return;
  }

  await fetchTargets();
};

const checkTarget = async (id) => {
  await fetch(`/api/targets/${id}/check`, { method: "POST" });
  await fetchTargets();
  await fetchHistory(id);
};

const fetchHistory = async (id) => {
  if (!id) {
    return;
  }
  const response = await fetch(`/api/targets/${id}/history`);
  const data = await response.json();
  renderHistory(data.history || []);
};

const checkAllTargets = async () => {
  for (const target of state.targets) {
    await checkTarget(target.id);
  }
};

const startAutoCheck = () => {
  const intervalSeconds = Math.max(5, Number(intervalInput.value) || 30);
  intervalInput.value = intervalSeconds;
  toggleAutoButton.textContent = "自動チェック停止";
  toggleAutoButton.classList.remove("secondary");
  toggleAutoButton.classList.add("danger");
  state.autoTimer = setInterval(checkAllTargets, intervalSeconds * 1000);
};

const stopAutoCheck = () => {
  clearInterval(state.autoTimer);
  state.autoTimer = null;
  toggleAutoButton.textContent = "自動チェック開始";
  toggleAutoButton.classList.remove("danger");
  toggleAutoButton.classList.add("secondary");
};

addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) {
    return;
  }
  urlInput.value = "";
  await addTarget(url);
});

refreshAllButton.addEventListener("click", checkAllTargets);

historySelect.addEventListener("change", async (event) => {
  await fetchHistory(event.target.value);
});

toggleAutoButton.addEventListener("click", () => {
  if (state.autoTimer) {
    stopAutoCheck();
  } else {
    startAutoCheck();
  }
});

fetchTargets();
