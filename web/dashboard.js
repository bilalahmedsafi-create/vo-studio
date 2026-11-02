const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
}

function studioLink(job) {
  return `${location.origin}/studio.html?job=${job.id}&key=${job.key}`;
}

function fileLink(job, name) {
  return `/files/${job.id}/${name}?key=${job.key}`;
}

function statusTag(job) {
  if (job.status === "error") return `<span class="tag bad">Error</span>`;
  if (job.status !== "ready") return `<span class="tag run">Processing</span>`;
  const r = job.render;
  if (r && r.status === "done") return `<span class="tag ok">Final ready</span>`;
  if (r && (r.status === "rendering" || r.status === "queued")) return `<span class="tag run">Rendering</span>`;
  if (r && r.status === "error") return `<span class="tag bad">Render failed</span>`;
  return `<span class="tag warn">Recording</span>`;
}

function versionHtml(job, r, latest) {
  const when = new Date(r.at * 1000).toLocaleString();
  const missing = r.missing && r.missing.length ? ` · <span style="color:var(--warn)">${r.missing.length} line(s) had no take</span>` : "";
  return `<div class="version ${latest ? "latest" : ""}">
    <span class="v">v${r.v}</span><span class="muted">${when}${missing}</span>
    ${r.mp4_removed ? `<span class="muted">video removed to save space (WAVs kept, re-render to get it back)</span>`
      : `<a href="${fileLink(job, `${r.dir}/final.mp4`)}" download="${esc(job.name)} v${r.v}.mp4"><strong>Final video.mp4</strong></a>`}
    <a href="${fileLink(job, `${r.dir}/vo_new.wav`)}" download="${esc(job.name)} v${r.v} new VO.wav">New VO.wav</a>
    <a href="${fileLink(job, `${r.dir}/mix.wav`)}" download="${esc(job.name)} v${r.v} mix.wav">Mix.wav</a>
  </div>`;
}

function jobHtml(job) {
  const r = job.render || {};
  const ready = job.status === "ready";
  const busy = r.status === "rendering" || r.status === "queued";
  const msg = !ready ? job.message : busy || r.status === "error" ? r.message : job.message;
  const renders = (job.renders || []).slice().reverse();
  const flags = job.flags_open || job.flags_redone
    ? ` · <span style="color:var(--bad)">${job.flags_open} flagged</span> · <span style="color:var(--warn)">${job.flags_redone} re-recorded</span>` : "";
  const downloads = ready
    ? `<div class="downloads">
         <a href="${fileLink(job, "bed.wav")}" download>Music + SFX (no VO).wav</a>
         <a href="${fileLink(job, "vo.wav")}" download>Old VO.wav</a>
       </div>
       ${renders.length ? `<div class="versions">${renders.map((v, i) => versionHtml(job, v, i === 0)).join("")}</div>` : ""}`
    : "";
  return `<div class="job" data-id="${job.id}">
    <div>
      <div class="name">${esc(job.name)} ${statusTag(job)}</div>
      <div class="meta">${esc(msg || "")}${ready ? ` · ${job.recorded}/${job.lines} lines recorded` : ""}${flags}</div>
    </div>
    <div class="actions">
      ${ready ? `<a href="${studioLink(job)}" target="_blank"><button class="primary">Open studio</button></a>
                 <button data-act="copy">Copy studio link</button>
                 ${renders.length ? `<a href="/review.html?job=${job.id}&key=${job.key}"><button>Review + flag</button></a>` : ""}
                 <button data-act="render" ${busy ? "disabled" : ""}>${busy ? "Rendering…" : "Render new version"}</button>` : ""}
      ${job.status === "error" ? `<button data-act="retry">Retry</button>` : ""}
    </div>
    ${downloads}
  </div>`;
}

let jobs = [];
async function refresh() {
  try {
    jobs = await (await fetch("/api/jobs")).json();
    $("#jobs").innerHTML = jobs.length ? jobs.map(jobHtml).join("") : `<div class="job"><span class="muted">No jobs yet.</span></div>`;
  } catch (e) {
    $("#jobs").innerHTML = `<div class="job"><span class="muted">Server not reachable. Is VO Studio running?</span></div>`;
  }
}

$("#jobs").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const job = jobs.find((j) => j.id === btn.closest(".job").dataset.id);
  if (btn.dataset.act === "copy") {
    await navigator.clipboard.writeText(studioLink(job));
    toast("Studio link copied");
  } else if (btn.dataset.act === "render") {
    const missing = job.lines - job.recorded;
    if (missing > 0 && !confirm(`${missing} line(s) have no take yet. They will be silent. Render anyway?`)) return;
    const res = await fetch(`/api/studio/${job.id}/submit?key=${job.key}`, { method: "POST" });
    toast(res.ok ? "Rendering started" : (await res.json()).detail);
    refresh();
  } else if (btn.dataset.act === "retry") {
    await fetch(`/api/jobs/${job.id}/retry`, { method: "POST" });
    refresh();
  }
});

function upload(file) {
  const xhr = new XMLHttpRequest();
  const form = new FormData();
  form.append("file", file);
  $("#upbar").hidden = false;
  $("#upmsg").textContent = `Uploading ${file.name}…`;
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      $("#upbar > i").style.width = `${(100 * e.loaded) / e.total}%`;
      $("#upmsg").textContent = `Uploading ${file.name}… ${Math.round((100 * e.loaded) / e.total)}%`;
    }
  };
  xhr.onload = () => {
    $("#upbar").hidden = true;
    $("#upmsg").textContent = xhr.status === 200 ? "Uploaded. Processing started." : `Upload failed: ${xhr.responseText}`;
    refresh();
  };
  xhr.onerror = () => ($("#upmsg").textContent = "Upload failed.");
  xhr.open("POST", "/api/jobs");
  xhr.send(form);
}

const drop = $("#drop");
drop.addEventListener("click", (e) => { if (e.target.tagName !== "INPUT") $("#file").click(); });
$("#file").addEventListener("change", (e) => e.target.files[0] && upload(e.target.files[0]));
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
});

$("#importBtn").addEventListener("click", async () => {
  const path = $("#path").value.trim();
  if (!path) return;
  const res = await fetch("/api/jobs/import", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }),
  });
  if (res.ok) { $("#path").value = ""; toast("Processing started"); } else toast((await res.json()).detail);
  refresh();
});

refresh();
setInterval(refresh, 2500);
