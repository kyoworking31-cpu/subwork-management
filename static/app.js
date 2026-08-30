(() => {
  const STATUS_DOT_CLASS = { 0: "dot-1", 1: "dot-2", 2: "dot-3", 3: "dot-4" };

  const ICON_USER = '<svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="6" r="3"/><path d="M3.5 15c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/></svg>';
  const ICON_CALENDAR = '<svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="13" height="12" rx="2"/><path d="M2.5 7h13M6 2v3M12 2v3"/></svg>';
  const ICON_CLOCK = '<svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="6.5"/><path d="M9 5.5V9l3 1.8"/></svg>';
  const ICON_LINK = '<svg width="13" height="13" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 10.5 15 3M15 3h-4.5M15 3v4.5"/><path d="M11 4.5H4.5A1.5 1.5 0 0 0 3 6v7.5A1.5 1.5 0 0 0 4.5 15H12a1.5 1.5 0 0 0 1.5-1.5V9.5"/></svg>';
  const ICON_PLUS = '<svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 3v12M3 9h12"/></svg>';

  let meta = { statuses: [], platforms: [] };
  let cards = [];
  let activeMobileStatus = null;
  let editingId = null;
  let searchQuery = "";
  let currentView = "board";
  let calYear, calMonth; // calMonth: 0-11
  let calEvents = [];

  const boardEl = document.getElementById("board");
  const tabsEl = document.getElementById("mobile-tabs");
  const searchInput = document.getElementById("search-input");
  const btnClearSearch = document.getElementById("btn-clear-search");
  const searchBarEl = document.getElementById("search-bar");
  const modalBackdrop = document.getElementById("modal-backdrop");
  const modalTitle = document.getElementById("modal-title");
  const form = document.getElementById("card-form");
  const toastEl = document.getElementById("toast");

  const viewToggleEl = document.getElementById("view-toggle");
  const calendarViewEl = document.getElementById("calendar-view");
  const calGridEl = document.getElementById("calendar-grid");
  const calMonthLabel = document.getElementById("cal-month-label");
  const calWarningEl = document.getElementById("cal-gcal-warning");
  const settingsModalBackdrop = document.getElementById("settings-modal-backdrop");
  const fieldGcalUrl = document.getElementById("field-gcal-url");
  const dayModalBackdrop = document.getElementById("day-modal-backdrop");
  const dayModalTitle = document.getElementById("day-modal-title");
  const dayModalList = document.getElementById("day-modal-list");

  const taxViewEl = document.getElementById("tax-view");
  const taxAmountInput = document.getElementById("tax-amount");
  const taxModeToggle = document.getElementById("tax-mode-toggle");
  const taxRoundToggle = document.getElementById("tax-round-toggle");
  const taxResultsEl = document.getElementById("tax-results");
  const taxNoteEl = document.getElementById("tax-note");

  const f = {
    id: document.getElementById("field-id"),
    platform: document.getElementById("field-platform"),
    status: document.getElementById("field-status"),
    genre: document.getElementById("field-genre"),
    clientName: document.getElementById("field-client-name"),
    clientContact: document.getElementById("field-client-contact"),
    appliedDate: document.getElementById("field-applied-date"),
    interviewAt: document.getElementById("field-interview-at"),
    dueDate: document.getElementById("field-due-date"),
    amount: document.getElementById("field-amount"),
    url: document.getElementById("field-url"),
    memo: document.getElementById("field-memo"),
  };

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.remove("hidden");
    setTimeout(() => toastEl.classList.add("hidden"), 2600);
  }

  function fmtDate(s) {
    return s ? s.replace(/-/g, "/") : "";
  }
  function fmtDateTime(s) {
    if (!s) return "";
    const [d, t] = s.split("T");
    return t ? `${fmtDate(d)} ${t}` : fmtDate(d);
  }
  function fmtAmount(n) {
    if (n === null || n === undefined || n === "") return "";
    return "¥" + Number(n).toLocaleString("ja-JP");
  }

  async function api(path, options) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (!res.ok) {
      let msg = "通信に失敗しました";
      try {
        const body = await res.json();
        if (body.error) msg = body.error;
      } catch (e) {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function loadMeta() {
    meta = await api("/api/meta");
    activeMobileStatus = meta.statuses[0];
    f.status.innerHTML = meta.statuses
      .map((s) => `<option value="${s}">${s}</option>`)
      .join("");
  }

  async function loadCards() {
    cards = await api("/api/cards");
    render();
  }

  function contextualDateRow(card) {
    switch (card.status) {
      case "応募中":
        return card.applied_date
          ? `<div class="card-row">${ICON_CALENDAR}応募日 ${fmtDate(card.applied_date)}</div>`
          : "";
      case "面談予定":
        return card.interview_at
          ? `<div class="card-row">${ICON_CLOCK}面談日時 ${fmtDateTime(card.interview_at)}</div>`
          : "";
      case "進行中":
        return card.due_date
          ? `<div class="card-row">${ICON_CALENDAR}納期 ${fmtDate(card.due_date)}</div>`
          : "";
      case "納品・完了":
        return card.due_date
          ? `<div class="card-row">${ICON_CALENDAR}完了日 ${fmtDate(card.due_date)}</div>`
          : "";
      default:
        return "";
    }
  }

  function renderCard(card) {
    const memo = card.memo
      ? `<div class="card-memo">メモ: ${escapeHtml(card.memo)}</div>`
      : "";
    const client = card.client_name
      ? `<div class="card-row">${ICON_USER}${escapeHtml(card.client_name)}</div>`
      : "";
    const link = card.url
      ? `<a class="card-link" href="${escapeAttr(card.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${ICON_LINK}元URL</a>`
      : "<span></span>";

    return `
      <div class="card" draggable="true" data-id="${card.id}">
        <span class="tag" data-platform="${escapeAttr(card.platform)}">${escapeHtml(card.platform)}</span>
        <div class="card-title">${escapeHtml(card.genre)}</div>
        ${client}
        ${contextualDateRow(card)}
        ${memo}
        <div class="card-footer">
          <span class="card-amount">${fmtAmount(card.amount)}</span>
          ${link}
        </div>
      </div>
    `;
  }

  function matchesSearch(card, query) {
    if (!query) return true;
    const haystack = [card.genre, card.client_name, card.platform, card.memo]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  }

  function render() {
    const query = searchQuery.trim().toLowerCase();
    const visibleCards = cards.filter((c) => matchesSearch(c, query));

    const grouped = {};
    meta.statuses.forEach((s) => (grouped[s] = []));
    visibleCards.forEach((c) => {
      if (grouped[c.status]) grouped[c.status].push(c);
    });

    boardEl.innerHTML = meta.statuses
      .map((status, i) => {
        const list = grouped[status];
        const emptyText = query
          ? "検索条件に一致する案件はありません"
          : "案件はまだありません";
        const cardsHtml = list.length
          ? list.map(renderCard).join("")
          : `<div class="empty-hint">${emptyText}</div>`;
        const activeClass = status === activeMobileStatus ? "active-mobile" : "";
        return `
          <div class="column ${activeClass}" data-status="${escapeAttr(status)}">
            <div class="column-header">
              <span class="dot ${STATUS_DOT_CLASS[i]}"></span>
              <span class="name">${status}</span>
              <span class="count">${list.length}</span>
            </div>
            ${cardsHtml}
            <button class="add-card-btn" data-status="${escapeAttr(status)}">${ICON_PLUS}カードを追加</button>
          </div>
        `;
      })
      .join("");

    tabsEl.innerHTML = meta.statuses
      .map((status) => {
        const count = grouped[status].length;
        const active = status === activeMobileStatus ? "active" : "";
        return `<div class="mobile-tab ${active}" data-status="${escapeAttr(status)}">${status} <span class="n">${count}</span></div>`;
      })
      .join("");

    wireBoardEvents();
  }

  function wireBoardEvents() {
    boardEl.querySelectorAll(".card").forEach((el) => {
      el.addEventListener("click", () => openEditModal(Number(el.dataset.id)));
      el.addEventListener("dragstart", () => el.classList.add("dragging"));
      el.addEventListener("dragend", () => el.classList.remove("dragging"));
    });

    boardEl.querySelectorAll(".add-card-btn").forEach((btn) => {
      btn.addEventListener("click", () => openNewModal(btn.dataset.status));
    });

    boardEl.querySelectorAll(".column").forEach((col) => {
      col.addEventListener("dragover", (e) => e.preventDefault());
      col.addEventListener("drop", async (e) => {
        e.preventDefault();
        const dragging = boardEl.querySelector(".card.dragging");
        if (!dragging) return;
        const id = Number(dragging.dataset.id);
        const newStatus = col.dataset.status;
        const card = cards.find((c) => c.id === id);
        if (!card || card.status === newStatus) return;
        try {
          await api(`/api/cards/${id}`, {
            method: "PUT",
            body: JSON.stringify({ status: newStatus }),
          });
          await loadCards();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    tabsEl.querySelectorAll(".mobile-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        activeMobileStatus = tab.dataset.status;
        render();
      });
    });
  }

  function openNewModal(status) {
    editingId = null;
    form.reset();
    f.id.value = "";
    f.status.value = status || meta.statuses[0];
    modalTitle.textContent = "新しい案件";
    document.getElementById("btn-delete-card").classList.add("hidden");
    modalBackdrop.classList.remove("hidden");
    f.platform.focus();
  }

  function openEditModal(id) {
    const card = cards.find((c) => c.id === id);
    if (!card) return;
    editingId = id;
    f.id.value = card.id;
    f.platform.value = card.platform;
    f.status.value = card.status;
    f.genre.value = card.genre || "";
    f.clientName.value = card.client_name || "";
    f.clientContact.value = card.client_contact || "";
    f.appliedDate.value = card.applied_date || "";
    f.interviewAt.value = card.interview_at || "";
    f.dueDate.value = card.due_date || "";
    f.amount.value = card.amount ?? "";
    f.url.value = card.url || "";
    f.memo.value = card.memo || "";
    modalTitle.textContent = "案件を編集";
    document.getElementById("btn-delete-card").classList.remove("hidden");
    modalBackdrop.classList.remove("hidden");
  }

  function closeModal() {
    modalBackdrop.classList.add("hidden");
    editingId = null;
  }

  function collectFormData() {
    return {
      platform: f.platform.value,
      status: f.status.value,
      genre: f.genre.value,
      client_name: f.clientName.value,
      client_contact: f.clientContact.value,
      applied_date: f.appliedDate.value,
      interview_at: f.interviewAt.value,
      due_date: f.dueDate.value,
      amount: f.amount.value,
      url: f.url.value,
      memo: f.memo.value,
    };
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = collectFormData();
    try {
      if (editingId) {
        await api(`/api/cards/${editingId}`, {
          method: "PUT",
          body: JSON.stringify(data),
        });
        showToast("案件を更新しました");
      } else {
        await api("/api/cards", {
          method: "POST",
          body: JSON.stringify(data),
        });
        showToast("案件を追加しました");
      }
      closeModal();
      await loadCards();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("btn-delete-card").addEventListener("click", async () => {
    if (!editingId) return;
    if (!confirm("この案件を削除しますか?")) return;
    try {
      await api(`/api/cards/${editingId}`, { method: "DELETE" });
      showToast("案件を削除しました");
      closeModal();
      await loadCards();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("btn-close-modal").addEventListener("click", closeModal);
  document.getElementById("btn-cancel").addEventListener("click", closeModal);
  modalBackdrop.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) closeModal();
  });
  document.getElementById("btn-new-card").addEventListener("click", () => openNewModal(null));

  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    btnClearSearch.classList.toggle("hidden", searchQuery.length === 0);
    render();
  });
  btnClearSearch.addEventListener("click", () => {
    searchQuery = "";
    searchInput.value = "";
    btnClearSearch.classList.add("hidden");
    searchInput.focus();
    render();
  });

  /* ---------- View switching ---------- */
  function switchView(view) {
    currentView = view;
    viewToggleEl.querySelectorAll(".view-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.view === view);
    });
    const isBoard = view === "board";
    const isCalendar = view === "calendar";
    const isTax = view === "tax";
    boardEl.classList.toggle("hidden", !isBoard);
    searchBarEl.classList.toggle("hidden", !isBoard);
    tabsEl.classList.toggle("hidden", !isBoard);
    calendarViewEl.classList.toggle("hidden", !isCalendar);
    taxViewEl.classList.toggle("hidden", !isTax);
    if (isCalendar) loadCalendarEvents();
  }

  viewToggleEl.querySelectorAll(".view-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });

  /* ---------- Calendar ---------- */
  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  function toDateStr(y, m, d) {
    return `${y}-${pad2(m + 1)}-${pad2(d)}`;
  }

  function calGridRange() {
    const first = new Date(calYear, calMonth, 1);
    const start = new Date(first);
    start.setDate(start.getDate() - start.getDay());
    const last = new Date(calYear, calMonth + 1, 0);
    const end = new Date(last);
    end.setDate(end.getDate() + (6 - end.getDay()) + 1); // exclusive
    return { start, end };
  }

  let calRequestId = 0;

  async function loadCalendarEvents(forceRefresh) {
    const requestId = ++calRequestId;
    const { start, end } = calGridRange();
    const startStr = toDateStr(start.getFullYear(), start.getMonth(), start.getDate());
    const endStr = toDateStr(end.getFullYear(), end.getMonth(), end.getDate());
    calMonthLabel.textContent = `${calYear}年${calMonth + 1}月`;
    try {
      const params = new URLSearchParams({ start: startStr, end: endStr });
      if (forceRefresh) params.set("refresh", "1");
      const data = await api(`/api/calendar/events?${params.toString()}`);
      if (requestId !== calRequestId) return; // 新しいリクエストが後から来ていたら破棄
      calEvents = data.events || [];
      if (data.gcal_error) {
        calWarningEl.textContent = data.gcal_error;
        calWarningEl.classList.remove("hidden");
      } else {
        calWarningEl.classList.add("hidden");
      }
    } catch (err) {
      if (requestId !== calRequestId) return;
      calEvents = [];
      calWarningEl.textContent = "予定の取得に失敗しました: " + err.message;
      calWarningEl.classList.remove("hidden");
    }
    renderCalendar();
  }

  function renderCalendar() {
    const { start, end } = calGridRange();
    const todayStr = toDateStr(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

    const byDate = {};
    calEvents.forEach((ev) => {
      (byDate[ev.date] = byDate[ev.date] || []).push(ev);
    });

    const cells = [];
    const cursor = new Date(start);
    while (cursor < end) {
      const y = cursor.getFullYear(), m = cursor.getMonth(), d = cursor.getDate();
      const dateStr = toDateStr(y, m, d);
      const dayEvents = (byDate[dateStr] || []).slice().sort((a, b) => (a.time || "").localeCompare(b.time || ""));
      const outside = m !== calMonth;
      const isToday = dateStr === todayStr;
      const visible = dayEvents.slice(0, 3);
      const moreCount = dayEvents.length - visible.length;

      const chipsHtml = visible
        .map((ev) => `<div class="cal-chip type-${ev.type}">${ev.time ? ev.time + " " : ""}${escapeHtml(ev.title)}</div>`)
        .join("");
      const moreHtml = moreCount > 0 ? `<div class="cal-more">+${moreCount}件</div>` : "";

      cells.push(`
        <div class="cal-day ${outside ? "outside" : ""} ${isToday ? "today" : ""} ${dayEvents.length ? "has-events" : ""}" data-date="${dateStr}">
          <div class="cal-day-num">${d}</div>
          ${chipsHtml}
          ${moreHtml}
        </div>
      `);
      cursor.setDate(cursor.getDate() + 1);
    }

    calGridEl.innerHTML = cells.join("");

    calGridEl.querySelectorAll(".cal-day.has-events").forEach((cell) => {
      cell.addEventListener("click", () => openDayModal(cell.dataset.date, byDate[cell.dataset.date] || []));
    });
  }

  const EVENT_TYPE_LABEL = { personal: "プライベート", interview: "面談", due: "納期" };
  const EVENT_TYPE_DOT = { personal: "dot-personal", interview: "dot-2", due: "dot-3" };

  function openDayModal(dateStr, events) {
    const [y, m, d] = dateStr.split("-").map(Number);
    dayModalTitle.textContent = `${m}月${d}日の予定`;
    dayModalList.innerHTML = events
      .map((ev) => {
        const clickable = ev.card_id ? "clickable" : "";
        return `
          <div class="day-event-row ${clickable}" data-card-id="${ev.card_id || ""}">
            <span class="dot ${EVENT_TYPE_DOT[ev.type]}"></span>
            <span class="day-event-time">${ev.time || "終日"}</span>
            <span class="day-event-title">${escapeHtml(ev.title)}<span style="color:var(--text-tertiary); font-size:12px;"> ・${EVENT_TYPE_LABEL[ev.type]}</span></span>
          </div>
        `;
      })
      .join("");
    dayModalList.querySelectorAll(".day-event-row.clickable").forEach((row) => {
      row.addEventListener("click", () => {
        closeDayModal();
        openEditModal(Number(row.dataset.cardId));
      });
    });
    dayModalBackdrop.classList.remove("hidden");
  }
  function closeDayModal() {
    dayModalBackdrop.classList.add("hidden");
  }

  document.getElementById("cal-prev").addEventListener("click", () => {
    calMonth -= 1;
    if (calMonth < 0) { calMonth = 11; calYear -= 1; }
    loadCalendarEvents();
  });
  document.getElementById("cal-next").addEventListener("click", () => {
    calMonth += 1;
    if (calMonth > 11) { calMonth = 0; calYear += 1; }
    loadCalendarEvents();
  });
  document.getElementById("cal-today").addEventListener("click", () => {
    const now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
    loadCalendarEvents();
  });
  document.getElementById("btn-close-day-modal").addEventListener("click", closeDayModal);
  dayModalBackdrop.addEventListener("click", (e) => {
    if (e.target === dayModalBackdrop) closeDayModal();
  });

  /* ---------- Calendar settings ---------- */
  async function openSettingsModal() {
    try {
      const data = await api("/api/settings");
      fieldGcalUrl.value = data.gcal_ics_url || "";
    } catch (err) {
      fieldGcalUrl.value = "";
    }
    settingsModalBackdrop.classList.remove("hidden");
  }
  function closeSettingsModal() {
    settingsModalBackdrop.classList.add("hidden");
  }

  document.getElementById("btn-cal-settings").addEventListener("click", openSettingsModal);
  document.getElementById("btn-close-settings").addEventListener("click", closeSettingsModal);
  document.getElementById("btn-cancel-settings").addEventListener("click", closeSettingsModal);
  settingsModalBackdrop.addEventListener("click", (e) => {
    if (e.target === settingsModalBackdrop) closeSettingsModal();
  });

  document.getElementById("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/settings", {
        method: "POST",
        body: JSON.stringify({ gcal_ics_url: fieldGcalUrl.value.trim() }),
      });
      showToast("設定を保存しました");
      closeSettingsModal();
      loadCalendarEvents(true);
    } catch (err) {
      showToast(err.message);
    }
  });

  /* ---------- Tax calculator ---------- */
  const TAX_RATES = [0.05, 0.08, 0.10];
  let taxMode = "excluded"; // "excluded" = 入力額は税抜, "included" = 入力額は税込
  let taxRoundMode = "floor";

  function applyRounding(value, mode) {
    switch (mode) {
      case "ceil": return Math.ceil(value);
      case "round": return Math.round(value);
      default: return Math.floor(value);
    }
  }

  function renderTaxResults() {
    const raw = Number(taxAmountInput.value);
    const amount = Number.isFinite(raw) && raw >= 0 ? raw : 0;
    const mismatches = [];

    taxResultsEl.innerHTML = TAX_RATES.map((rate) => {
      let base, taxAmount, total;
      if (taxMode === "excluded") {
        base = amount;
        taxAmount = applyRounding(base * rate, taxRoundMode);
        total = base + taxAmount;
      } else {
        total = amount;
        base = applyRounding(total / (1 + rate), taxRoundMode);
        taxAmount = total - base;

        // 検算: この税抜金額を他サービスへ入力し税額計算をやり直すと、端数処理の影響で
        // 元の税込金額と1円前後ずれることがある。ずれる場合は一致する金額を併せて示す。
        const recheckTotal = base + applyRounding(base * rate, taxRoundMode);
        if (recheckTotal !== total) {
          let adjustedBase = base;
          for (let delta = -2; delta <= 2; delta++) {
            const candidate = base + delta;
            if (candidate >= 0 && candidate + applyRounding(candidate * rate, taxRoundMode) === total) {
              adjustedBase = candidate;
              break;
            }
          }
          mismatches.push({ rate, base, recheckTotal, adjustedBase, total });
        }
      }
      const rowClass = rate === 0.10 ? "rate-10" : "";
      return `
        <tr class="${rowClass}">
          <td>${Math.round(rate * 100)}%</td>
          <td>${fmtAmount(base)}</td>
          <td>${fmtAmount(taxAmount)}</td>
          <td>${fmtAmount(total)}</td>
        </tr>
      `;
    }).join("");

    renderTaxNote(mismatches);
  }

  function renderTaxNote(mismatches) {
    if (mismatches.length === 0) {
      taxNoteEl.classList.add("hidden");
      taxNoteEl.innerHTML = "";
      return;
    }
    const lines = mismatches
      .map((m) => {
        const pct = Math.round(m.rate * 100);
        let line = `${pct}%: 税抜¥${m.base.toLocaleString("ja-JP")}を他サービスへ入力し税計算し直すと¥${m.recheckTotal.toLocaleString("ja-JP")}になります(元の¥${m.total.toLocaleString("ja-JP")}と${m.recheckTotal - m.total > 0 ? "+" : ""}${m.recheckTotal - m.total}円)。`;
        if (m.adjustedBase !== m.base) {
          line += `ぴったり¥${m.total.toLocaleString("ja-JP")}にしたい場合は¥${m.adjustedBase.toLocaleString("ja-JP")}を試してください。`;
        }
        return `<div class="tax-note-line">${line}</div>`;
      })
      .join("");
    taxNoteEl.innerHTML = `<strong>ご注意:</strong> 税込金額から逆算した税抜金額を、他のサービス(クラウドワークス等)の「税抜金額」欄へ入力して税を計算し直すと、端数処理の関係で1円前後ずれることがあります。${lines}`;
    taxNoteEl.classList.remove("hidden");
  }

  taxAmountInput.addEventListener("input", renderTaxResults);

  taxModeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".pill");
    if (!btn) return;
    taxMode = btn.dataset.mode;
    taxModeToggle.querySelectorAll(".pill").forEach((p) => p.classList.toggle("active", p === btn));
    renderTaxResults();
  });

  taxRoundToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".pill");
    if (!btn) return;
    taxRoundMode = btn.dataset.round;
    taxRoundToggle.querySelectorAll(".pill").forEach((p) => p.classList.toggle("active", p === btn));
    renderTaxResults();
  });

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str);
    return div.innerHTML;
  }
  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, "&quot;");
  }

  (async function init() {
    const now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
    taxAmountInput.value = "10000";
    renderTaxResults();
    try {
      await loadMeta();
      await loadCards();
    } catch (err) {
      showToast("読み込みに失敗しました: " + err.message);
    }
  })();
})();
