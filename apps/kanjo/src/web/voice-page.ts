import type { Product, Store } from "../store.js";
import { formatUsdc } from "../money.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function catalogHtml(products: Product[]): string {
  if (products.length === 0) return `<p class="muted">El catálogo está vacío.</p>`;
  const groups = new Map<string, Product[]>();
  for (const product of products) {
    const key = product.category || "Productos";
    groups.set(key, [...(groups.get(key) ?? []), product]);
  }
  return [...groups.entries()]
    .map(
      ([category, items]) => `
      <section class="cat">
        <h3>${escapeHtml(category)}</h3>
        <div class="grid">
          ${items
            .map(
              (p) => `
            <button type="button" class="item${p.stock > 0 ? "" : " out"}" data-name="${escapeHtml(p.name)}">
              ${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ""}
              <span class="name">${escapeHtml(p.name)}</span>
              ${p.description ? `<span class="desc">${escapeHtml(p.description)}</span>` : ""}
              <span class="price">${formatUsdc(p.price_atomic)} USDC${p.stock > 0 ? "" : " · agotado"}</span>
            </button>`
            )
            .join("")}
        </div>
      </section>`
    )
    .join("");
}

export function renderVoicePage({ store, products, voice }: { store: Store; products: Product[]; voice: boolean }): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${escapeHtml(store.name)} · Kanjō</title>
  <style>
    :root { --bg:#f6f5f1; --card:#fff; --ink:#1b1b1b; --muted:#6b6b6b; --accent:#e84142; --line:#ebe9e3; --me:#1b1b1b; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: system-ui, -apple-system, sans-serif; background:var(--bg); color:var(--ink); }
    header { padding:20px 16px 8px; max-width:1100px; margin:0 auto; display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
    header h1 { font-size:22px; margin:0; }
    .badge { font-size:12px; background:#fff; border:1px solid var(--line); border-radius:999px; padding:3px 10px; color:var(--muted); }
    main { max-width:1100px; margin:0 auto; padding:8px 16px 24px; display:grid; grid-template-columns: 1.1fr .9fr; gap:16px; }
    @media (max-width: 860px) { main { grid-template-columns: 1fr; } .catalog { order:2; } }
    .panel { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:16px; }
    .catalog h2, .chat h2 { font-size:15px; margin:0 0 8px; color:var(--muted); font-weight:600; }
    .cat h3 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:16px 0 8px; }
    .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap:10px; }
    .item { text-align:left; background:#fbfaf7; border:1px solid var(--line); border-radius:14px; padding:12px; display:flex; flex-direction:column; gap:4px; cursor:pointer; font:inherit; color:inherit; }
    .item:hover { border-color:#d7d3c8; }
    .item.out { opacity:.5; }
    .item img { width:100%; aspect-ratio: 4/3; object-fit:cover; border-radius:10px; margin-bottom:4px; }
    .item .name { font-weight:650; font-size:14px; }
    .item .desc { font-size:12px; color:var(--muted); }
    .item .price { font-size:13px; font-weight:600; margin-top:auto; }
    .chat { display:flex; flex-direction:column; min-height:520px; position:sticky; top:12px; }
    #log { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding:4px 2px 12px; max-height:60vh; }
    .msg { max-width:88%; padding:10px 12px; border-radius:16px; font-size:15px; line-height:1.4; white-space:pre-wrap; word-wrap:break-word; }
    .me { align-self:flex-end; background:var(--me); color:#fff; border-bottom-right-radius:6px; }
    .bot { align-self:flex-start; background:#f1efe9; border-bottom-left-radius:6px; }
    .bot a { color:var(--accent); font-weight:600; }
    .msg .tag { display:block; font-size:11px; opacity:.65; margin-bottom:2px; }
    .play { margin-top:6px; border:0; background:none; color:var(--accent); font:inherit; font-size:13px; cursor:pointer; padding:0; }
    .controls { display:flex; gap:8px; align-items:center; border-top:1px solid var(--line); padding-top:12px; }
    #mic { width:64px; height:64px; border-radius:50%; border:0; background:var(--accent); color:#fff; font-size:26px; cursor:pointer; flex:none; transition: transform .15s; }
    #mic.rec { animation: pulse 1s infinite; background:#b3261e; }
    #mic:disabled { background:#bbb; cursor:wait; animation:none; }
    @keyframes pulse { 50% { transform: scale(1.08); } }
    form { flex:1; display:flex; gap:6px; }
    input[type=text] { flex:1; padding:12px; border:1px solid var(--line); border-radius:12px; font:inherit; }
    form button { padding:0 14px; border:0; border-radius:12px; background:var(--ink); color:#fff; font:inherit; cursor:pointer; }
    .status { font-size:13px; color:var(--muted); min-height:18px; margin-top:6px; }
    label.toggle { font-size:13px; color:var(--muted); display:flex; gap:6px; align-items:center; margin-top:4px; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(store.name)}</h1>
    <span class="badge">Kanjō · agente de ventas · pagos en USDC con Sekisho</span>
  </header>
  <main>
    <div class="panel catalog">
      <h2>Menú</h2>
      ${catalogHtml(products)}
    </div>
    <div class="panel chat">
      <h2>Habla con el agente</h2>
      <div id="log">
        <div class="msg bot">¡Hola! Soy el asistente de ${escapeHtml(store.name)}. ${voice ? "Toca el micrófono y dime qué se te antoja, o escríbelo." : "Escríbeme qué se te antoja."}</div>
      </div>
      <div class="controls">
        ${voice ? `<button id="mic" type="button" title="Hablar">🎙️</button>` : ""}
        <form id="form"><input id="text" type="text" placeholder="Escribe tu pedido…" autocomplete="off" /><button>Enviar</button></form>
      </div>
      ${voice ? `<label class="toggle"><input id="voiceReplies" type="checkbox" checked /> Respuestas en voz</label>` : ""}
      <div class="status" id="status"></div>
    </div>
  </main>
  <script>
  (() => {
    const log = document.getElementById("log");
    const statusEl = document.getElementById("status");
    const mic = document.getElementById("mic");
    const form = document.getElementById("form");
    const input = document.getElementById("text");
    const voiceToggle = document.getElementById("voiceReplies");
    let session;
    try { session = localStorage.getItem("kanjo-session"); } catch {}
    if (!session || !/^[a-z0-9]{8,32}$/.test(session)) {
      session = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join("");
      try { localStorage.setItem("kanjo-session", session); } catch {}
    }

    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const format = (s) =>
      esc(s)
        .replace(/\\*([^*\\n]+)\\*/g, "<b>$1</b>")
        .replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">Abrir link de pago ↗</a>');

    function add(kind, text, tag) {
      const div = document.createElement("div");
      div.className = "msg " + kind;
      div.innerHTML = (tag ? '<span class="tag">' + esc(tag) + "</span>" : "") + (kind === "bot" ? format(text) : esc(text));
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      return div;
    }

    let current;
    function play(src) {
      if (current) current.pause();
      current = new Audio(src);
      current.play().catch(() => {});
    }

    async function send(body, label) {
      body.append("session", session);
      body.append("voice", voiceToggle && !voiceToggle.checked ? "0" : "1");
      statusEl.textContent = "Pensando…";
      if (mic) mic.disabled = true;
      try {
        const res = await fetch("/voice/api", { method: "POST", body });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Error " + res.status);
        if (data.transcript) add("me", data.transcript, label);
        for (const reply of data.replies || []) {
          const div = add("bot", reply.text);
          if (reply.audio) {
            const again = document.createElement("button");
            again.className = "play";
            again.type = "button";
            again.textContent = "▶ Escuchar";
            again.onclick = () => play(reply.audio);
            div.appendChild(again);
            play(reply.audio);
          }
        }
        statusEl.textContent = "";
      } catch (error) {
        statusEl.textContent = "⚠️ " + error.message;
      } finally {
        if (mic) mic.disabled = false;
      }
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      add("me", text);
      const body = new FormData();
      body.append("text", text);
      send(body);
    });

    document.querySelectorAll(".item").forEach((el) =>
      el.addEventListener("click", () => {
        input.value = (input.value ? input.value + ", " : "Quiero ") + el.dataset.name;
        input.focus();
      })
    );

    if (!mic) return;
    let recorder, chunks = [], stopTimer;
    const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    const mimeType = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";

    mic.addEventListener("click", async () => {
      if (recorder && recorder.state === "recording") {
        recorder.stop();
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        chunks = [];
        recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        recorder.onstop = () => {
          clearTimeout(stopTimer);
          stream.getTracks().forEach((t) => t.stop());
          mic.classList.remove("rec");
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          if (blob.size < 1200) { statusEl.textContent = "No se grabó nada; intenta de nuevo."; return; }
          const body = new FormData();
          body.append("audio", blob, "voz." + (blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm"));
          send(body, "🎙️ dijiste");
        };
        recorder.start();
        mic.classList.add("rec");
        statusEl.textContent = "Escuchando… toca de nuevo para enviar";
        stopTimer = setTimeout(() => recorder.state === "recording" && recorder.stop(), 30000);
      } catch (error) {
        statusEl.textContent = "⚠️ Sin acceso al micrófono: " + error.message;
      }
    });
  })();
  </script>
</body>
</html>`;
}
