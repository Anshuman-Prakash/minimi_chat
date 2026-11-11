// Minimal chat client: posts a message, reads the SSE reply, renders markdown.

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const inputEl = $("input");
const sendBtn = document.querySelector("#composer button");
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

let conversationId = null;
let busy = false;

const renderMarkdown = (text) => DOMPurify.sanitize(marked.parse(text));
const formatTime = (iso) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function addMessage(role, text, createdAt) {
  messagesEl.querySelector(".empty")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.innerHTML = `<div class="body"></div><div class="time"></div>`;
  const body = el.querySelector(".body");
  if (role === "user") body.textContent = text;
  else body.innerHTML = renderMarkdown(text);
  if (createdAt) el.querySelector(".time").textContent = formatTime(createdAt);
  messagesEl.append(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

async function loadConversations() {
  const list = await (await fetch("/api/conversations")).json();
  $("conversations").replaceChildren(
    ...list.map((c) => {
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = c.title;
      a.className = c.id === conversationId ? "active" : "";
      const when = document.createElement("small");
      when.textContent = formatTime(c.created_at);
      a.append(when);
      a.onclick = (e) => { e.preventDefault(); openConversation(c.id); };
      return a;
    }),
  );
}

async function openConversation(id) {
  if (busy) return;
  conversationId = id;
  messagesEl.replaceChildren();
  const rows = await (await fetch(`/api/conversations/${id}/messages`)).json();
  for (const m of rows) addMessage(m.role, m.content, m.created_at);
  loadConversations();
}

function newChat() {
  if (busy) return;
  conversationId = null;
  messagesEl.innerHTML = `<p class="empty">Ask anything. I can search the web, and I remember our past conversations by date.</p>`;
  loadConversations();
  inputEl.focus();
}

async function send(text) {
  busy = true;
  sendBtn.disabled = true;
  addMessage("user", text, new Date().toISOString());
  const el = addMessage("assistant", "");
  const body = el.querySelector(".body");
  body.innerHTML = `<span class="status">Thinking…</span>`;

  let answer = "";
  let renderQueued = false;
  const render = () => {
    renderQueued = false;
    body.innerHTML = renderMarkdown(answer);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  const handle = (event, data) => {
    if (event === "status" && !answer) body.querySelector(".status").textContent = data.text;
    if (event === "delta") {
      answer += data.text;
      if (!renderQueued) { renderQueued = true; requestAnimationFrame(render); } // at most one render per frame
    }
    if (event === "done") {
      conversationId = data.conversationId;
      const { ttftMs, totalMs } = data.timings;
      el.querySelector(".time").textContent = `${formatTime(new Date().toISOString())} · first token ${ttftMs ?? "–"} ms · total ${totalMs} ms`;
    }
    if (event === "error") {
      conversationId = data.conversationId;
      body.innerHTML = `<span class="error"></span>`;
      body.firstChild.textContent = data.message;
    }
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, tz, ...(conversationId ? { conversationId } : {}) }),
    });
    if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

    // SSE frames are separated by a blank line: "event: x\ndata: {json}\n\n".
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (event && data) handle(event, JSON.parse(data));
      }
    }
  } catch (err) {
    handle("error", { message: `Connection problem: ${err.message}`, conversationId });
  } finally {
    busy = false;
    sendBtn.disabled = false;
    loadConversations();
    inputEl.focus();
  }
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text || busy) return;
  inputEl.value = "";
  inputEl.style.height = "auto";
  send(text);
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); }
});
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = `${inputEl.scrollHeight}px`;
});
$("new-chat").addEventListener("click", newChat);

loadConversations();
