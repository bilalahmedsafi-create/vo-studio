// VO Studio – recording page for the VO artist.
// Timeline time = seconds in the original video. Takes are stored with `offset` = timeline time
// of their first sample; `nudge` is the artist's manual shift on top of that.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const params = new URLSearchParams(location.search);
const JOB = params.get("job");
const KEY = params.get("key");
const api = (p) => `/api/studio/${JOB}${p}${p.includes("?") ? "&" : "?"}key=${encodeURIComponent(KEY)}`;
const fileUrl = (name) => `/files/${JOB}/${name}?key=${encodeURIComponent(KEY)}`;
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

const prefs = loadPrefs();
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem("vo-studio-prefs")) || {}; } catch { return {}; }
}
function savePrefs() {
  try { localStorage.setItem("vo-studio-prefs", JSON.stringify(prefs)); } catch {}
}

let job = null;
let lines = [];
let idx = 0;
let voPeaks = null;
let bedPeaks = null;
const takeCache = new Map();          // take file -> { buffer, peaks }

const video = $("#video");
const guide = new Audio();
guide.preload = "auto";

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}

// ---------------------------------------------------------------- audio engine

const ctx = new AudioContext({ latencyHint: "interactive" });
let micStream = null;
let micNode = null;
let inputLatency = 0.01;
let level = 0;
const rec = { on: false, chunks: [], V0: 0, C0: 0, lineId: null };

async function initMic() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: prefs.micId ? { exact: prefs.micId } : undefined,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1,
    },
  });
  const track = micStream.getAudioTracks()[0];
  inputLatency = track.getSettings().latency || 0.01;
  if (!micNode) {
    await ctx.audioWorklet.addModule("recorder-worklet.js");
    micNode = new AudioWorkletNode(ctx, "recorder");
    const sink = ctx.createGain();
    sink.gain.value = 0;
    micNode.connect(sink).connect(ctx.destination);
    micNode.port.onmessage = (e) => {
      const d = e.data.data;
      let peak = 0;
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
      level = Math.max(peak, level * 0.92);
      if (rec.on) rec.chunks.push(e.data);
    };
  }
  if (initMic.source) initMic.source.disconnect();
  initMic.source = ctx.createMediaStreamSource(micStream);
  initMic.source.connect(micNode);
  await fillMicList();
  showLatency();
}

async function fillMicList() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  const current = micStream && micStream.getAudioTracks()[0].getSettings().deviceId;
  $("#micSel").innerHTML = devices.map((d) =>
    `<option value="${d.deviceId}" ${d.deviceId === current ? "selected" : ""}>${esc(d.label || "Microphone")}</option>`).join("");
}

function outputLatency() {
  return (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
}

function totalLatency() {
  return outputLatency() + inputLatency + (job.sync_offset_ms || 0) / 1000;
}

function showLatency() {
  $("#latencyInfo").textContent =
    `Measured: output ${(outputLatency() * 1000).toFixed(0)} ms + mic ${(inputLatency * 1000).toFixed(0)} ms. ` +
    `Takes are shifted back by this automatically.`;
}

async function ensureAudio(needMic = true) {
  if (ctx.state !== "running") await ctx.resume();
  if (needMic && !micStream) {
    try { await initMic(); } catch (e) { toast("Microphone blocked. Allow mic access in the address bar.", 5000); throw e; }
  }
}

function beep(at, freq = 880, dur = 0.08) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(0.12, at + 0.005);
  g.gain.setValueAtTime(0.12, at + dur - 0.01);
  g.gain.linearRampToValueAtTime(0, at + dur);
  o.connect(g).connect(ctx.destination);
  o.start(at);
  o.stop(at + dur + 0.02);
}

async function takeData(take) {
  if (takeCache.has(take.file)) return takeCache.get(take.file);
  const buf = await (await fetch(fileUrl(`takes/${take.file}`))).arrayBuffer();
  const buffer = await ctx.decodeAudioData(buf);
  const entry = { buffer, peaks: computePeaks(buffer.getChannelData(0), buffer.sampleRate) };
  takeCache.set(take.file, entry);
  return entry;
}

function computePeaks(data, sr) {
  const hop = Math.floor(sr / 100);
  const n = Math.floor(data.length / hop);
  const out = new Float32Array(n);
  let max = 1e-6;
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) p = Math.max(p, Math.abs(data[j]));
    out[i] = p;
    max = Math.max(max, p);
  }
  for (let i = 0; i < n; i++) out[i] /= max;
  return out;
}

function encodeWav(samples, sr) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

// ---------------------------------------------------------------- transport (play / record)

const transport = { mode: null, stopAt: 0, sources: [] };

function seek(t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 0.01) return resolve();
    video.addEventListener("seeked", () => resolve(), { once: true });
    video.currentTime = t;
  });
}

const capturing = (mode) => mode === "rec" || mode === "run";

async function startTransport(from, to, mode) {
  await ensureAudio(capturing(mode));
  stopTransport();
  from = Math.max(0, from);
  await seek(from);
  const useGuide = capturing(mode) ? $("#guideRec").checked : $("#guidePlay").checked;
  guide.currentTime = from;
  transport.mode = mode;
  transport.stopAt = to;
  if (capturing(mode)) {
    rec.chunks = [];
    rec.lineId = lines[idx].id;
    rec.firstStart = lines[idx].start;
    rec.on = true;
  }
  await Promise.all([video.play(), useGuide ? guide.play() : Promise.resolve()]);
  const V0 = video.currentTime;
  const C0 = ctx.currentTime;
  if (capturing(mode)) {
    rec.V0 = V0;
    rec.C0 = C0;
    if ($("#beeps").checked) {
      for (const k of [3, 2, 1]) {
        const at = C0 + (rec.firstStart - k * 0.5 - V0);
        if (at > ctx.currentTime) beep(at, k === 1 ? 1320 : 880);
      }
    }
    $("#recBadge").textContent = mode === "run" ? "● REC RUN – keep reading, press R or Stop to end" : "● REC";
    $("#recBadge").classList.add("show");
    const btn = mode === "run" ? $("#runBtn") : $("#recBtn");
    btn.classList.add("on");
    btn.textContent = "■ Stop";
  } else {
    await scheduleTakes(from, to, V0, C0);
  }
  $("#playBtn").textContent = mode === "play" ? "■ Stop" : "▶ Play line";
}

async function scheduleTakes(from, to, V0, C0) {
  for (const line of lines) {
    if (line.end < from - 5 || line.start > to + 1) continue;
    const st = job.takes[line.id];
    const take = st && st.takes.find((t) => t.n === st.chosen);
    if (!take) continue;
    const { buffer } = await takeData(take);
    if (transport.mode !== "play") return;
    const pos = take.offset + (st.nudge || 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const at = C0 + (pos - V0);
    const now = ctx.currentTime;
    if (at >= now) src.start(at);
    else if (now - at < buffer.duration) src.start(now, now - at);
    else continue;
    transport.sources.push(src);
  }
}

function stopTransport() {
  if (!transport.mode) return;
  const mode = transport.mode;
  transport.mode = null;
  video.pause();
  guide.pause();
  transport.sources.forEach((s) => { try { s.stop(); } catch {} });
  transport.sources = [];
  $("#playBtn").textContent = "▶ Play line";
  $("#recBadge").classList.remove("show");
  $("#countdown").classList.remove("show");
  $("#recBtn").classList.remove("on");
  $("#recBtn").textContent = "● Record line";
  $("#runBtn").classList.remove("on");
  $("#runBtn").textContent = "● Record run";
  if (capturing(mode)) finishRecording(mode);
}

async function finishRecording(mode) {
  rec.on = false;
  const chunks = rec.chunks;
  rec.chunks = [];
  if (!chunks.length) return;
  const sr = ctx.sampleRate;
  const total = chunks.reduce((n, c) => n + c.data.length, 0);
  if (total < sr * 0.5) return toast("Take too short, not saved");
  const samples = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { samples.set(c.data, o); o += c.data.length; }
  // Timeline position of the first sample: video time at C0 plus elapsed audio-clock time,
  // minus the round trip (what he hears is late by output latency, the mic adds input latency).
  const offset = rec.V0 + (chunks[0].t - rec.C0) - totalLatency();
  if (mode === "run") return saveRun(samples, sr, offset);
  const form = new FormData();
  form.append("line_id", rec.lineId);
  form.append("offset", offset.toFixed(4));
  form.append("duration", (total / sr).toFixed(3));
  form.append("file", encodeWav(samples, sr), `${rec.lineId}.wav`);
  toast("Saving take…");
  const res = await fetch(api("/takes"), { method: "POST", body: form });
  if (!res.ok) return toast("Saving take failed – try again");
  const st = await res.json();
  job.takes[rec.lineId] = st;
  const flag = job.flags[rec.lineId];
  if (flag && flag.status === "open") Object.assign(flag, { status: "re-recorded", take: st.chosen });
  const take = st.takes.find((t) => t.n === st.chosen);
  const buffer = ctx.createBuffer(1, samples.length, sr);
  buffer.copyToChannel(samples, 0);
  takeCache.set(take.file, { buffer, peaks: computePeaks(samples, sr) });
  toast(`Take ${take.n} saved`);
  renderLineList();
  renderLine();
  if (job.render) pollRender();
}

async function saveRun(samples, sr, offset) {
  const form = new FormData();
  form.append("offset", offset.toFixed(4));
  form.append("file", encodeWav(samples, sr), "run.wav");
  toast("Saving run and splitting it into lines…", 6000);
  const res = await fetch(api("/runs"), { method: "POST", body: form });
  if (!res.ok) {
    let msg = "Saving run failed – try again";
    try { msg = (await res.json()).detail; } catch {}
    return toast(msg, 5000);
  }
  const { takes, flags } = await res.json();
  Object.assign(job.takes, takes);
  job.flags = flags;
  const ids = Object.keys(takes);
  toast(`Run saved: ${ids.length} line${ids.length > 1 ? "s" : ""} (${ids[0]}–${ids[ids.length - 1]}). Check each one, redo any single line with R.`, 6000);
  renderLineList();
  renderLine();
  if (job.render) pollRender();
}

function playLine() {
  if (transport.mode) return stopTransport();
  const line = lines[idx];
  startTransport(line.start - 1, line.end + 1.2, "play").catch(() => stopTransport());
}

function recordLine() {
  if (capturing(transport.mode)) return stopTransport();
  const line = lines[idx];
  const pre = Number(prefs.preroll || 2);
  startTransport(line.start - pre, line.end + 2.5, "rec").catch(() => stopTransport());
}

// Run-through: keeps recording across lines until stopped; the server splits it per line.
function recordRun() {
  if (capturing(transport.mode)) return stopTransport();
  const line = lines[idx];
  const pre = Number(prefs.preroll || 2);
  startTransport(line.start - pre, Infinity, "run").catch(() => stopTransport());
}

// During a run, the prompter and list follow the playhead without stopping the recording.
function followPlayhead() {
  const t = video.currentTime;
  let i = idx;
  while (i + 1 < lines.length && lines[i + 1].start - 0.3 <= t) i++;
  if (i !== idx) {
    idx = i;
    renderLineList();
    scrollToCurrent();
    renderLine();
  }
}

// ---------------------------------------------------------------- UI: lines, prompter, takes

function lineState(line) {
  const st = job.takes[line.id];
  return st && st.chosen ? "done" : "";
}

function flagOf(line) {
  return (job.flags || {})[line.id];
}

function renderLineList() {
  const q = $("#search").value.trim().toLowerCase();
  const onlyFlagged = $("#onlyFlagged").checked;
  $("#lines").innerHTML = lines.map((l, i) => {
    if (q && !l.text.toLowerCase().includes(q)) return "";
    const flag = flagOf(l);
    if (onlyFlagged && !(flag && flag.status === "open")) return "";
    const st = job.takes[l.id];
    const n = st ? st.takes.length : 0;
    const icon = flag && flag.status === "open" ? `<span style="color:var(--bad)">⚑</span>` : lineState(l) ? "✔" : "○";
    const note = flag && flag.status === "open"
      ? `<div class="x" style="color:var(--bad);font-size:12px">Redo${flag.note ? `: ${esc(flag.note)}` : ""}</div>` : "";
    return `<div class="ln ${i === idx ? "cur" : ""} ${lineState(l)}" data-i="${i}">
      <div class="st">${icon}</div>
      <div class="t">${l.id} · ${fmt(l.start)}${n ? ` · ${n} take${n > 1 ? "s" : ""}` : ""}${flag && flag.status === "re-recorded" ? " · redo done" : ""}</div>
      <div class="x">${esc(l.text)}</div>${note}</div>`;
  }).join("") || `<div class="ln"><div></div><div class="x muted">No lines match.</div></div>`;
  const done = lines.filter(lineState).length;
  const open = lines.filter((l) => (flagOf(l) || {}).status === "open").length;
  $("#progress").textContent = `${done} / ${lines.length} recorded${open ? ` · ${open} to redo` : ""}`;
  $("#progress").className = `tag ${open ? "bad" : done === lines.length ? "ok" : ""}`;
}

function scrollToCurrent() {
  const el = $(`.ln[data-i="${idx}"]`);
  if (el) el.scrollIntoView({ block: "nearest" });
}

async function selectLine(i) {
  stopTransport();
  idx = Math.max(0, Math.min(lines.length - 1, i));
  prefs[`idx-${JOB}`] = idx;
  savePrefs();
  renderLineList();
  scrollToCurrent();
  renderLine();
  await seek(Math.max(0, lines[idx].start - 0.2));
}

function renderLine() {
  const line = lines[idx];
  $("#lineId").textContent = line.id;
  $("#lineTime").textContent = `${fmt(line.start)} – ${fmt(line.end)}`;
  $("#lineLen").textContent = `${(line.end - line.start).toFixed(1)} s`;
  $("#nowText").textContent = line.text;
  $("#nextText").textContent = lines[idx + 1] ? `Next: ${lines[idx + 1].text}` : "Last line";
  const flag = flagOf(line);
  $("#flagNote").hidden = !(flag && flag.status === "open");
  $("#flagNote").textContent = flag ? `⚑ Redo requested${flag.note ? `: ${flag.note}` : ""}` : "";
  const st = job.takes[line.id];
  $("#takes").innerHTML = st && st.takes.length
    ? st.takes.map((t, k) => `<button data-n="${t.n}" class="${t.n === st.chosen ? "chosen" : ""}" title="Use take ${t.n} (${k + 1})">Take ${t.n}</button>`).join("")
    : `<span class="muted">none yet</span>`;
  const take = st && st.takes.find((t) => t.n === st.chosen);
  if (take) takeData(take).then(drawTimeline);
  drawTimeline();
}

async function chooseTake(n) {
  const line = lines[idx];
  const res = await fetch(api(`/lines/${line.id}`), {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chosen: n }),
  });
  if (res.ok) {
    job.takes[line.id] = await res.json();
    renderLine();
    renderLineList();
  }
}

let nudgeTimer = null;
function setNudge(value, save = true) {
  const line = lines[idx];
  const st = job.takes[line.id];
  if (!st) return;
  st.nudge = Math.max(-2, Math.min(2, value));
  drawTimeline();
  if (!save) return;
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => fetch(api(`/lines/${line.id}`), {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nudge: st.nudge }),
  }), 300);
}

// ---------------------------------------------------------------- timeline canvas

const tl = $("#tl");
const ov = $("#overview");
const RULER = 18;
let view = { w0: 0, w1: 10 };

function sizeCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const r = c.getBoundingClientRect();
  if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) {
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
  }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, W: r.width, H: r.height };
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawPeaks(g, peaks, rate, t0, x, y, h, color, W) {
  // peaks: values 0..1 at `rate` per second starting at timeline time t0
  g.fillStyle = color;
  const mid = y + h / 2;
  for (let px = 0; px < W; px++) {
    const ta = view.w0 + (px / W) * (view.w1 - view.w0);
    const tb = view.w0 + ((px + 1) / W) * (view.w1 - view.w0);
    const a = Math.floor((ta - t0) * rate);
    const b = Math.max(a + 1, Math.floor((tb - t0) * rate));
    if (b <= 0 || a >= peaks.length) continue;
    let p = 0;
    for (let i = Math.max(0, a); i < Math.min(peaks.length, b); i++) p = Math.max(p, peaks[i]);
    const hh = Math.max(1, p * h * 0.95);
    g.fillRect(px, mid - hh / 2, 1, hh);
  }
}

function lanes(H) {
  const laneH = (H - RULER) / 2;
  return { guideY: RULER, takeY: RULER + laneH, laneH };
}

function tx(t, W) { return ((t - view.w0) / (view.w1 - view.w0)) * W; }

function drawTimeline() {
  if (!lines.length) return;
  const { g, W, H } = sizeCanvas(tl);
  const line = lines[idx];
  const st = job.takes[line.id];
  const take = st && st.takes.find((t) => t.n === st.chosen);
  let end = line.end + 3;
  if (take) end = Math.max(end, take.offset + (st.nudge || 0) + take.duration * 0.6);
  view = { w0: line.start - 2.5, w1: Math.max(end, line.start + 6) };
  const { guideY, takeY, laneH } = lanes(H);

  g.clearRect(0, 0, W, H);
  g.fillStyle = css("--panel");
  g.fillRect(0, 0, W, H);
  // current line region
  g.fillStyle = "rgba(255,122,61,0.07)";
  g.fillRect(tx(line.start, W), RULER, tx(line.end, W) - tx(line.start, W), H - RULER);
  // ruler
  g.fillStyle = css("--muted");
  g.font = "11px system-ui";
  const step = (view.w1 - view.w0) > 20 ? 5 : 1;
  for (let t = Math.max(0, Math.ceil(view.w0 / step) * step); t < view.w1; t += step) {
    const x = tx(t, W);
    g.fillRect(x, RULER - 5, 1, 5);
    g.fillText(fmt(t), x + 3, 12);
  }
  g.fillStyle = css("--line");
  g.fillRect(0, takeY, W, 1);
  g.fillRect(0, RULER - 0.5, W, 1);
  // neighbour line boundaries + labels
  g.font = "10px system-ui";
  for (const l of lines) {
    if (l.end < view.w0 || l.start > view.w1) continue;
    const x = tx(l.start, W);
    g.fillStyle = l === line ? css("--accent") : "#3a4150";
    g.fillRect(x, RULER, 1, H - RULER);
    g.fillText(l.id, x + 3, RULER + 11);
  }
  // waveforms
  if (bedPeaks) drawPeaks(g, bedPeaks.peaks, bedPeaks.rate, 0, 0, guideY, laneH, css("--bed"), W);
  if (voPeaks) drawPeaks(g, voPeaks.peaks, voPeaks.rate, 0, 0, guideY, laneH, css("--guide"), W);
  for (const l of lines) {   // other lines' takes, faint, so overlaps are visible
    const s = job.takes[l.id];
    const t = s && s.takes.find((k) => k.n === s.chosen);
    if (!t || l === line) continue;
    const pos = t.offset + (s.nudge || 0);
    if (pos > view.w1 || pos + t.duration < view.w0) continue;
    const d = takeCache.get(t.file);
    if (d) drawPeaks(g, d.peaks, 100, pos, 0, takeY, laneH, "rgba(255,122,61,0.3)", W);
    else takeData(t).then(drawTimeline);
  }
  if (take) {
    const d = takeCache.get(take.file);
    const pos = take.offset + (st.nudge || 0);
    if (d) drawPeaks(g, d.peaks, 100, pos, 0, takeY, laneH, css("--accent"), W);
    g.fillStyle = css("--muted");
    g.fillText(`take ${take.n}${st.nudge ? ` · nudge ${st.nudge > 0 ? "+" : ""}${Math.round(st.nudge * 1000)} ms` : ""}`, 6, H - 6);
  } else {
    g.fillStyle = css("--muted");
    g.font = "12px system-ui";
    g.fillText("No take yet – press R to record this line", 8, takeY + laneH / 2 + 4);
  }
  g.font = "10px system-ui";
  g.fillStyle = css("--guide");
  g.fillText("OLD VO", W - 44, guideY + 12);
  g.fillStyle = css("--accent");
  g.fillText("YOUR TAKE", W - 60, takeY + 12);
  // playhead
  const ph = tx(video.currentTime, W);
  if (ph >= 0 && ph <= W) {
    g.fillStyle = "#fff";
    g.fillRect(ph, 0, 1.5, H);
  }
  drawOverview();
}

function drawOverview() {
  const { g, W, H } = sizeCanvas(ov);
  const dur = job.duration || (lines.length ? lines[lines.length - 1].end + 2 : 1);
  g.fillStyle = css("--panel-2");
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    g.fillStyle = i === idx ? css("--accent") : lineState(l) ? css("--ok") : "#4a5160";
    const x = (l.start / dur) * W;
    g.fillRect(x, i === idx ? 3 : 7, Math.max(2, ((l.end - l.start) / dur) * W - 1), i === idx ? H - 6 : H - 14);
  }
  g.fillStyle = "#fff";
  g.fillRect((video.currentTime / dur) * W, 0, 1, H);
}

// drag the take to nudge it; click elsewhere to scrub
let drag = null;
tl.addEventListener("pointerdown", (e) => {
  const r = tl.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  const { takeY } = lanes(r.height);
  const st = job.takes[lines[idx].id];
  if (y >= takeY && st && st.chosen) {
    drag = { x0: x, nudge0: st.nudge || 0, W: r.width };
    tl.setPointerCapture(e.pointerId);
    tl.style.cursor = "grabbing";
  } else if (!transport.mode) {
    seek(view.w0 + (x / r.width) * (view.w1 - view.w0)).then(drawTimeline);
  }
});
tl.addEventListener("pointermove", (e) => {
  const r = tl.getBoundingClientRect();
  if (drag) {
    const dt = ((e.clientX - r.left - drag.x0) / drag.W) * (view.w1 - view.w0);
    setNudge(Math.round((drag.nudge0 + dt) * 1000) / 1000, false);
  } else {
    const { takeY } = lanes(r.height);
    tl.style.cursor = e.clientY - r.top >= takeY && job.takes[lines[idx].id] ? "grab" : "default";
  }
});
tl.addEventListener("pointerup", () => {
  if (!drag) return;
  drag = null;
  tl.style.cursor = "grab";
  setNudge(job.takes[lines[idx].id].nudge || 0, true);
});
ov.addEventListener("click", (e) => {
  const r = ov.getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * (job.duration || 1);
  let best = 0;
  lines.forEach((l, i) => { if (Math.abs(l.start - t) < Math.abs(lines[best].start - t)) best = i; });
  selectLine(best);
});

// animation: playhead, countdown, auto-stop, mic meter
function tick() {
  if (transport.mode) {
    if (video.currentTime >= transport.stopAt || video.ended) stopTransport();
    if (transport.mode === "run") followPlayhead();
    if (capturing(transport.mode)) {
      const left = rec.firstStart - video.currentTime;
      const cd = $("#countdown");
      if (left > 0 && left <= 1.5) { cd.textContent = String(Math.ceil(left / 0.5)); cd.classList.add("show"); }
      else cd.classList.remove("show");
    }
    if (!guide.paused && Math.abs(guide.currentTime - video.currentTime) > 0.08) guide.currentTime = video.currentTime;
    drawTimeline();
  }
  const m = $("#meter");
  m.firstElementChild.style.width = `${Math.min(100, level * 100)}%`;
  m.classList.toggle("hot", level > 0.9);
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- controls

$("#lines").addEventListener("click", (e) => {
  const el = e.target.closest(".ln");
  if (el) selectLine(Number(el.dataset.i));
});
$("#search").addEventListener("input", renderLineList);
$("#onlyFlagged").addEventListener("change", renderLineList);
$("#runBtn").addEventListener("click", recordRun);
$("#takes").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-n]");
  if (b) chooseTake(Number(b.dataset.n));
});
$("#playBtn").addEventListener("click", playLine);
$("#recBtn").addEventListener("click", recordLine);
$("#prevBtn").addEventListener("click", () => selectLine(idx - 1));
$("#nextBtn").addEventListener("click", () => selectLine(idx + 1));
for (const id of ["guidePlay", "guideRec"]) {
  $(`#${id}`).checked = prefs[id] ?? $(`#${id}`).checked;
  $(`#${id}`).addEventListener("change", (e) => { prefs[id] = e.target.checked; savePrefs(); });
}

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input[type=text], select") || e.repeat) return;
  const st = job && job.takes[lines[idx].id];
  if (e.code === "Space") { e.preventDefault(); playLine(); }
  else if (e.key === "R" && e.shiftKey) recordRun();
  else if (e.key === "r" || e.key === "R") recordLine();
  else if (e.key === "ArrowUp") { e.preventDefault(); selectLine(idx - 1); }
  else if (e.key === "ArrowDown") { e.preventDefault(); selectLine(idx + 1); }
  else if (e.key === "," && st) setNudge((st.nudge || 0) - 0.01);
  else if (e.key === "." && st) setNudge((st.nudge || 0) + 0.01);
  else if (/^[1-9]$/.test(e.key) && st && st.takes[Number(e.key) - 1]) chooseTake(st.takes[Number(e.key) - 1].n);
});

// settings dialog
$("#settingsBtn").addEventListener("click", async () => {
  try { await ensureAudio(); } catch {}
  showLatency();
  $("#settings").showModal();
});
$("#settingsClose").addEventListener("click", () => $("#settings").close());
$("#micSel").addEventListener("change", async (e) => { prefs.micId = e.target.value; savePrefs(); await initMic(); });
$("#syncRange").addEventListener("input", (e) => { $("#syncVal").textContent = e.target.value; });
$("#syncRange").addEventListener("change", async (e) => {
  job.sync_offset_ms = Number(e.target.value);
  await fetch(api("/settings"), {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sync_offset_ms: job.sync_offset_ms }),
  });
});
$("#preroll").value = prefs.preroll || 2;
$("#prerollVal").textContent = $("#preroll").value;
$("#preroll").addEventListener("input", (e) => { prefs.preroll = Number(e.target.value); $("#prerollVal").textContent = e.target.value; savePrefs(); });
$("#beeps").checked = prefs.beeps ?? true;
$("#beeps").addEventListener("change", (e) => { prefs.beeps = e.target.checked; savePrefs(); });

// submit
$("#submitBtn").addEventListener("click", async () => {
  const missing = lines.filter((l) => !lineState(l)).length;
  const msg = missing
    ? `${missing} line(s) have no take yet and will be silent. Submit anyway?`
    : "All lines recorded. Submit for the final render?";
  if (!confirm(msg)) return;
  const res = await fetch(api("/submit"), { method: "POST" });
  if (!res.ok) return toast((await res.json()).detail);
  toast("Submitted! Rendering the final video…", 4000);
  pollRender();
});

async function pollRender() {
  const j = await (await fetch(api(""))).json();
  const r = j.render || {};
  const lastTake = Math.max(0, ...Object.values(job.takes).flatMap((s) => s.takes.map((t) => t.at || 0)));
  $("#submitBtn").textContent = r.status === "done"
    ? (lastTake > r.at ? "Submit changes for render" : `✔ Submitted – v${r.v} ready`)
    : r.status === "error" ? "Render failed – submit again" : `Rendering: ${r.message || "…"}`;
  $("#submitBtn").disabled = r.status === "rendering" || r.status === "queued";
  if (r.status === "rendering" || r.status === "queued") setTimeout(pollRender, 2000);
}

window.addEventListener("resize", drawTimeline);

// ---------------------------------------------------------------- boot

async function boot() {
  if (!JOB || !KEY) { $("#title").textContent = "Missing studio link"; return; }
  const res = await fetch(api(""));
  if (!res.ok) { $("#title").textContent = "This studio link is not valid"; return; }
  job = await res.json();
  if (job.status !== "ready") { $("#title").textContent = `Not ready yet: ${job.message}`; setTimeout(boot, 3000); return; }
  lines = job.lines;
  job.flags = job.flags || {};
  document.title = `${job.name} – VO Studio`;
  $("#title").textContent = job.name;
  $("#syncRange").value = job.sync_offset_ms || 0;
  $("#syncVal").textContent = job.sync_offset_ms || 0;
  video.src = fileUrl("proxy.mp4");
  guide.src = fileUrl("guide.m4a");
  [voPeaks, bedPeaks] = await Promise.all([
    fetch(fileUrl("vo_peaks.json")).then((r) => r.json()),
    fetch(fileUrl("bed_peaks.json")).then((r) => r.json()),
  ]);
  voPeaks.peaks = Float32Array.from(voPeaks.peaks, (v) => v / 127);
  bedPeaks.peaks = Float32Array.from(bedPeaks.peaks, (v) => (v / 127) * 0.6);
  idx = Math.min(prefs[`idx-${JOB}`] || 0, lines.length - 1);
  renderLineList();
  await selectLine(idx);
  if (job.render && job.render.status) pollRender();
  requestAnimationFrame(tick);
}
boot();
