// VO Studio – owner review: watch a rendered version, flag lines for the VO artist to redo.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const params = new URLSearchParams(location.search);
const JOB = params.get("job");
const KEY = params.get("key");
const api = (p) => `/api/studio/${JOB}${p}${p.includes("?") ? "&" : "?"}key=${encodeURIComponent(KEY)}`;
const fileUrl = (name) => `/files/${JOB}/${name}?key=${encodeURIComponent(KEY)}`;
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const json = { "Content-Type": "application/json" };

let job = null;
let lines = [];
let idx = -1;
const video = $("#video");

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}

function flagOf(line) { return (job.flags || {})[line.id]; }

function renderSummary() {
  const flags = Object.values(job.flags || {});
  const open = flags.filter((f) => f.status === "open").length;
  const redone = flags.filter((f) => f.status === "re-recorded").length;
  $("#summary").textContent = `${open} flagged · ${redone} re-recorded`;
  $("#summary").className = `tag ${open ? "bad" : redone ? "warn" : "ok"}`;
}

function renderList() {
  const q = $("#search").value.trim().toLowerCase();
  const only = $("#onlyFlagged").checked;
  $("#lines").innerHTML = lines.map((l, i) => {
    const f = flagOf(l);
    if (q && !l.text.toLowerCase().includes(q)) return "";
    if (only && !f) return "";
    const icon = !f ? "○" : f.status === "open" ? `<span style="color:var(--bad)">⚑</span>` : `<span style="color:var(--warn)">↻</span>`;
    const note = f ? `<div class="x" style="font-size:12px;color:${f.status === "open" ? "var(--bad)" : "var(--warn)"}">
      ${f.status === "open" ? "Flagged" : `Re-recorded (take ${f.take}) – render to hear it`}${f.note ? `: ${esc(f.note)}` : ""}</div>` : "";
    return `<div class="ln ${i === idx ? "cur" : ""}" data-i="${i}">
      <div class="st">${icon}</div><div class="t">${l.id} · ${fmt(l.start)}</div>
      <div class="x">${esc(l.text)}</div>${note}</div>`;
  }).join("") || `<div class="ln"><div></div><div class="x muted">No lines match.</div></div>`;
}

function renderCurrent() {
  const line = lines[idx];
  if (!line) return;
  $("#lineId").textContent = line.id;
  $("#lineTime").textContent = `${fmt(line.start)} – ${fmt(line.end)}`;
  $("#nowText").textContent = line.text;
  const f = flagOf(line);
  $("#flagState").innerHTML = !f ? "" : f.status === "open"
    ? `<span class="tag bad">⚑ flagged</span>` : `<span class="tag warn">re-recorded, take ${f.take}</span>`;
  $("#flagBtn").textContent = f && f.status === "re-recorded" ? "⚑ Flag again" : f ? "⚑ Update flag" : "⚑ Flag for redo";
  $("#unflagBtn").hidden = !f;
  if (document.activeElement !== $("#note")) $("#note").value = f && f.status === "open" ? f.note : "";
}

function setCurrent(i, scroll = true) {
  if (i === idx) return;
  idx = i;
  renderList();
  renderCurrent();
  const el = $(`.ln[data-i="${idx}"]`);
  if (scroll && el) el.scrollIntoView({ block: "nearest" });
}

function lineAt(t) {
  let i = 0;
  while (i + 1 < lines.length && lines[i + 1].start - 0.3 <= t) i++;
  return i;
}

video.addEventListener("timeupdate", () => setCurrent(lineAt(video.currentTime)));

function jump(i) {
  i = Math.max(0, Math.min(lines.length - 1, i));
  video.currentTime = Math.max(0, lines[i].start - 0.3);
  setCurrent(i);
}

$("#lines").addEventListener("click", (e) => {
  const el = e.target.closest(".ln[data-i]");
  if (!el) return;
  jump(Number(el.dataset.i));
  video.play();
});
$("#search").addEventListener("input", renderList);
$("#onlyFlagged").addEventListener("change", renderList);

async function flag() {
  const line = lines[idx];
  if (!line) return toast("Play the video or pick a line first");
  const res = await fetch(api(`/flags/${line.id}`), { method: "PUT", headers: json, body: JSON.stringify({ note: $("#note").value }) });
  if (!res.ok) return toast("Could not save flag");
  job.flags = await res.json();
  $("#note").blur();
  toast(`${line.id} flagged for redo`);
  renderSummary(); renderList(); renderCurrent();
}

async function unflag() {
  const line = lines[idx];
  const res = await fetch(api(`/flags/${line.id}`), { method: "DELETE" });
  if (!res.ok) return;
  job.flags = await res.json();
  $("#note").value = "";
  renderSummary(); renderList(); renderCurrent();
}

$("#flagBtn").addEventListener("click", flag);
$("#unflagBtn").addEventListener("click", unflag);
$("#note").addEventListener("focus", () => video.pause());
$("#note").addEventListener("keydown", (e) => { if (e.key === "Enter") flag(); if (e.key === "Escape") $("#note").blur(); });

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input[type=text], select")) return;
  if (e.code === "Space") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (e.key === "f" || e.key === "F") { e.preventDefault(); video.pause(); $("#note").focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); jump(idx - 1); }
  else if (e.key === "ArrowDown") { e.preventDefault(); jump(idx + 1); }
});

function fillVersions(selectV) {
  const versions = (job.renders || []).filter((r) => !r.mp4_removed).slice().reverse();
  $("#version").innerHTML = versions.length
    ? versions.map((r) => `<option value="${r.v}">Version ${r.v} · ${new Date(r.at * 1000).toLocaleString()}</option>`).join("")
    : `<option>No render yet</option>`;
  const pick = versions.find((r) => r.v === selectV) || versions[0];
  if (pick) {
    $("#version").value = pick.v;
    loadVersion(pick);
  }
}

function loadVersion(r) {
  const t = video.currentTime || 0;
  video.src = fileUrl(`${r.dir}/final.mp4`);
  if (t > 0) video.addEventListener("loadedmetadata", () => { video.currentTime = t; }, { once: true });
}

$("#version").addEventListener("change", (e) => {
  const r = (job.renders || []).find((x) => x.v === Number(e.target.value));
  if (r) loadVersion(r);
});

$("#renderBtn").addEventListener("click", async () => {
  const open = Object.values(job.flags || {}).filter((f) => f.status === "open").length;
  if (open && !confirm(`${open} flagged line(s) are not re-recorded yet. Render anyway?`)) return;
  const res = await fetch(api("/submit"), { method: "POST" });
  if (!res.ok) return toast((await res.json()).detail);
  pollRender();
});

async function pollRender() {
  const j = await (await fetch(api(""))).json();
  const r = j.render || {};
  const busy = r.status === "rendering" || r.status === "queued";
  $("#renderBtn").disabled = busy;
  $("#renderBtn").textContent = busy ? `Rendering v${r.v || ""}: ${r.message || "…"}` : "Render new version";
  if (busy) return setTimeout(pollRender, 2000);
  if (r.status === "done" && (job.renders || []).length !== (j.renders || []).length) {
    job.renders = j.renders;
    fillVersions(r.v);
    toast(`Version ${r.v} ready`);
  }
  if (r.status === "error") toast(`Render failed: ${r.message}`, 6000);
}

async function boot() {
  const res = await fetch(api(""));
  if (!res.ok) { $("#title").textContent = "This link is not valid"; return; }
  job = await res.json();
  job.flags = job.flags || {};
  lines = job.lines;
  document.title = `Review – ${job.name}`;
  $("#title").textContent = `Review: ${job.name}`;
  renderSummary();
  fillVersions();
  setCurrent(0);
  pollRender();
}
boot();
