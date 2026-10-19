(function () {
  const STORAGE_KEY = "assistant.chats.v1";
  const THEME_KEY = "assistant.theme";

  const $ = (id) => document.getElementById(id);
  const els = {
    sidebar: $("sidebar"), backdrop: $("backdrop"),
    openSidebar: $("openSidebar"), closeSidebar: $("closeSidebar"),
    newChat: $("newChat"), chatList: $("chatList"), chatListEmpty: $("chatListEmpty"),
    chatTitle: $("chatTitle"), status: $("status"), statusText: $("statusText"),
    themeToggle: $("themeToggle"), scroller: $("scroller"), welcome: $("welcome"),
    messages: $("messages"), form: $("composer"), input: $("input"), send: $("send"),
  };

  const ICON_SPARK = '<svg viewBox="0 0 24 24"><path d="M12 3l1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9z"/></svg>';
  const ICON_COPY = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>';
  const ICON_RETRY = '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0114-5.3L20 9M20 4v5h-5M20 12a8 8 0 01-14 5.3L4 15M4 20v-5h5"/></svg>';
  const ICON_TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/></svg>';

  // ---------- Хранилище (localStorage может быть недоступен) ----------
  const storage = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватный режим и т.п. */ }
    },
  };

  const state = {
    chats: storage.get(STORAGE_KEY, []), // [{id, title, messages:[{role, content}], updatedAt}]
    currentId: null,
    controller: null, // AbortController текущего запроса
  };

  const save = () => storage.set(STORAGE_KEY, state.chats);
  const currentChat = () => state.chats.find((c) => c.id === state.currentId) || null;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const isBusy = () => state.controller !== null;

  // ---------- Тема ----------
  function applyTheme(theme) {
    if (theme) document.documentElement.dataset.theme = theme;
  }
  applyTheme(storage.get(THEME_KEY, null) ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  els.themeToggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    storage.set(THEME_KEY, next);
  });

  // ---------- Подключение к серверу ----------
  const API_BASE = (window.ASSISTANT_API_URL || "").replace(/\/+$/, "");
  const api = (path) => (API_BASE ? `${API_BASE}/api/${path}` : `api/${path}`);

  // Если сервера нет (например, сайт на GitHub Pages), ответы генерируются в браузере.
  const connection = fetch(api("config"))
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .catch(() => ({ demo: true, offline: true }));
  connection.then(({ model, demo }) => {
    els.status.classList.add(demo ? "is-demo" : "is-live");
    els.statusText.textContent = demo ? "Демо-режим" : model;
  });

  // ---------- Сайдбар ----------
  function toggleSidebar(open) {
    els.sidebar.classList.toggle("is-open", open);
    els.backdrop.hidden = !open;
  }
  els.openSidebar.addEventListener("click", () => toggleSidebar(true));
  els.closeSidebar.addEventListener("click", () => toggleSidebar(false));
  els.backdrop.addEventListener("click", () => toggleSidebar(false));

  function renderChatList() {
    const sorted = [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt);
    els.chatList.replaceChildren(...sorted.map((chat) => {
      const item = document.createElement("div");
      item.className = "chat-item" + (chat.id === state.currentId ? " is-active" : "");
      const open = document.createElement("button");
      open.className = "chat-item__open";
      open.textContent = chat.title;
      open.title = chat.title;
      open.addEventListener("click", () => { openChat(chat.id); toggleSidebar(false); });
      const del = document.createElement("button");
      del.className = "chat-item__delete";
      del.setAttribute("aria-label", "Удалить чат");
      del.innerHTML = ICON_TRASH;
      del.addEventListener("click", () => deleteChat(chat.id));
      item.append(open, del);
      return item;
    }));
    els.chatListEmpty.hidden = state.chats.length > 0;
  }

  function deleteChat(id) {
    if (!confirm("Удалить этот диалог?")) return;
    if (id === state.currentId) { stopGeneration(); state.currentId = null; }
    state.chats = state.chats.filter((c) => c.id !== id);
    save();
    renderAll();
  }

  // ---------- Сообщения ----------
  function messageEl(role, content) {
    const wrap = document.createElement("div");
    wrap.className = `msg msg--${role}`;
    const body = document.createElement("div");
    body.className = "msg__body";
    if (role === "assistant") {
      const avatar = document.createElement("div");
      avatar.className = "msg__avatar";
      avatar.innerHTML = ICON_SPARK;
      wrap.append(avatar);
      const md = document.createElement("div");
      md.className = "md";
      md.innerHTML = window.renderMarkdown(content);
      body.append(md);
    } else {
      body.textContent = content;
    }
    wrap.append(body);
    return wrap;
  }

  function addActions(msgEl, getText) {
    const actions = document.createElement("div");
    actions.className = "msg__actions";
    const copy = document.createElement("button");
    copy.className = "msg__action";
    copy.innerHTML = ICON_COPY + "<span>Копировать</span>";
    copy.addEventListener("click", () => copyText(getText(), copy.querySelector("span")));
    actions.append(copy);
    msgEl.querySelector(".msg__body").append(actions);
  }

  function renderMessages() {
    const chat = currentChat();
    const list = chat ? chat.messages : [];
    els.welcome.hidden = list.length > 0;
    els.messages.replaceChildren(...list.map((m) => {
      const el = messageEl(m.role, m.content);
      if (m.role === "assistant") addActions(el, () => m.content);
      return el;
    }));
    els.chatTitle.textContent = chat ? chat.title : "Новый чат";
    scrollToBottom(true);
  }

  function renderAll() {
    renderChatList();
    renderMessages();
    updateSendButton();
  }

  function openChat(id) {
    if (id === state.currentId) return;
    stopGeneration();
    state.currentId = id;
    renderAll();
  }

  function scrollToBottom(force) {
    const s = els.scroller;
    const nearBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 120;
    if (force || nearBottom) s.scrollTop = s.scrollHeight;
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      const prev = label.textContent;
      label.textContent = "Скопировано";
      setTimeout(() => { label.textContent = prev; }, 1500);
    } catch { /* буфер обмена недоступен */ }
  }

  // Копирование блоков кода
  els.messages.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-copy-code]");
    if (btn) copyText(btn.closest("pre").querySelector("code").textContent, btn);
  });

  // ---------- Отправка ----------
  function updateSendButton() {
    els.send.classList.toggle("is-stop", isBusy());
    els.send.setAttribute("aria-label", isBusy() ? "Остановить" : "Отправить");
    els.send.disabled = !isBusy() && !els.input.value.trim();
  }

  function autoResize() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 200) + "px";
  }

  els.input.addEventListener("input", () => { autoResize(); updateSendButton(); });
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      els.form.requestSubmit();
    }
  });
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (isBusy()) return stopGeneration();
    const text = els.input.value.trim();
    if (!text) return;
    els.input.value = "";
    autoResize();
    sendMessage(text);
  });

  document.querySelectorAll(".suggestion").forEach((btn) =>
    btn.addEventListener("click", () => sendMessage(btn.dataset.prompt)));

  els.newChat.addEventListener("click", () => {
    stopGeneration();
    state.currentId = null;
    renderAll();
    toggleSidebar(false);
    els.input.focus();
  });

  function stopGeneration() {
    if (state.controller) state.controller.abort();
  }

  function sendMessage(text) {
    if (isBusy()) return;
    let chat = currentChat();
    if (!chat) {
      chat = { id: uid(), title: text.slice(0, 60), messages: [], updatedAt: Date.now() };
      state.chats.push(chat);
      state.currentId = chat.id;
    }
    chat.messages.push({ role: "user", content: text });
    chat.updatedAt = Date.now();
    save();
    renderAll();
    requestAnswer(chat);
  }

  async function requestAnswer(chat) {
    const el = messageEl("assistant", "");
    const body = el.querySelector(".msg__body");
    const md = body.querySelector(".md");
    md.innerHTML =
      '<div class="typing" role="status"><span class="typing__dots"><span></span><span></span><span></span></span>Ассистент думает…</div>';
    els.messages.append(el);
    scrollToBottom(true);

    const controller = new AbortController();
    state.controller = controller;
    updateSendButton();

    let answer = "";
    let errorText = null;
    let notice = null;
    let frame = 0;

    const paint = () => {
      frame = 0;
      md.innerHTML = window.renderMarkdown(answer);
      scrollToBottom(false);
    };

    try {
      const { offline } = await connection;
      const events = offline
        ? demoEvents(chat.messages.at(-1).content, controller.signal)
        : serverEvents(chat.messages, controller.signal);
      for await (const event of events) {
        if (event.type === "delta") {
          if (!answer) el.classList.add("is-streaming");
          answer += event.text;
          if (!frame) frame = requestAnimationFrame(paint);
        } else if (event.type === "error") {
          errorText = event.message;
        } else if (event.type === "notice") {
          notice = event.message;
        }
      }
    } catch (err) {
      if (err.name === "AbortError") {
        if (!answer) notice = "Генерация остановлена.";
      } else {
        errorText = err.message === "Failed to fetch" ? "Нет соединения с сервером." : err.message;
      }
    } finally {
      if (frame) cancelAnimationFrame(frame);
      state.controller = null;
      el.classList.remove("is-streaming");
      updateSendButton();
    }

    // Сохраняем даже частичный ответ, если пользователь остановил генерацию
    if (answer) {
      chat.messages.push({ role: "assistant", content: answer });
      chat.updatedAt = Date.now();
      save();
      renderChatList();
      md.innerHTML = window.renderMarkdown(answer);
      addActions(el, () => answer);
    } else {
      md.innerHTML = "";
    }

    if (notice) {
      const n = document.createElement("div");
      n.className = "msg__notice";
      n.textContent = notice;
      body.append(n);
    }
    if (errorText) {
      const box = document.createElement("div");
      box.className = "msg__error";
      box.textContent = errorText;
      if (!answer) {
        const retry = document.createElement("button");
        retry.innerHTML = ICON_RETRY + "Повторить";
        retry.addEventListener("click", () => {
          el.remove();
          if (state.currentId === chat.id) requestAnswer(chat);
        });
        box.append(retry);
      }
      body.append(box);
    }
    scrollToBottom(false);
  }

  // Поток событий от сервера (Server-Sent Events поверх POST-запроса)
  async function* serverEvents(messages, signal) {
    const res = await fetch(api("chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
      signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Ошибка сервера (${res.status})`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop();
      for (const raw of chunks) {
        const line = raw.trim();
        if (line.startsWith("data:")) yield JSON.parse(line.slice(5));
      }
    }
  }

  // Тестовые ответы, когда сервер с моделью недоступен
  async function* demoEvents(question, signal) {
    const answer =
      `**Демо-режим.** Сайт открыт без сервера с языковой моделью, поэтому это тестовый ответ.\n\n` +
      `Вы спросили:\n\n> ${question.replace(/\n/g, "\n> ")}\n\n` +
      `Чтобы подключить модель, запустите сервер из репозитория (\`npm start\` с ключом \`ANTHROPIC_API_KEY\`) ` +
      "и укажите его адрес в файле `config.js`.";
    await new Promise((r) => setTimeout(r, 600));
    for (const chunk of answer.match(/.{1,6}/gs)) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      yield { type: "delta", text: chunk };
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  renderAll();
  els.input.focus();
})();
