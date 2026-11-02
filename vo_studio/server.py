"""Local VO Studio server: owner dashboard, VO artist studio, job API.

Run:  python -m vo_studio.server   (then open http://localhost:8790)
"""
import io
import json
import secrets
import shutil
import threading
import time
import traceback
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
import soundfile as sf
from pydantic import BaseModel

from . import pipeline

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
JOBS = ROOT / "data" / "jobs"
JOBS.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="VO Studio")
lock = threading.Lock()
work_queue = threading.Semaphore(1)   # one heavy job at a time on this PC


# ---------------------------------------------------------------- job storage

def job_path(job_id):
    p = JOBS / job_id
    if not (p / "job.json").exists():
        raise HTTPException(404, "job not found")
    return p


def load(job_id):
    return json.loads((job_path(job_id) / "job.json").read_text())


def save(job):
    with lock:
        f = JOBS / job["id"] / "job.json"
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(job, indent=1))
        tmp.replace(f)


def update(job_id, **fields):
    with lock:
        f = JOBS / job_id / "job.json"
        job = json.loads(f.read_text())
        job.update(fields)
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(job, indent=1))
        tmp.replace(f)
        return job


def check_key(job, key):
    if key != job["key"]:
        raise HTTPException(403, "wrong studio link")


def video_of(job):
    """The job's original video: its saved path, or source.mp4 inside the job folder (shared jobs)."""
    p = Path(job["video"])
    if not p.is_absolute():
        p = JOBS / job["id"] / p
    return p if p.is_file() else JOBS / job["id"] / "source.mp4"


def public(job):
    return {k: v for k, v in job.items() if k not in ("video",)}


# ---------------------------------------------------------------- background work

def run_prepare(job_id):
    with work_queue:
        job = load(job_id)
        try:
            update(job_id, status="processing")
            result = pipeline.prepare(JOBS / job_id, video_of(job), lambda m: update(job_id, message=m))
            update(job_id, status="ready", message="Ready for recording", **result)
        except Exception as e:
            traceback.print_exc()
            update(job_id, status="error", message=f"{type(e).__name__}: {e}")


KEEP_MP4_VERSIONS = 3   # older versions keep their WAVs; their 1.5 GB video file is removed


def run_render(job_id):
    with work_queue:
        job = load(job_id)
        v = max([r["v"] for r in job.get("renders", [])], default=0) + 1
        try:
            update(job_id, render={"status": "rendering", "message": "Starting", "v": v})
            result = pipeline.render(JOBS / job_id, job, video_of(job), JOBS / job_id / "final" / f"v{v}",
                                     lambda m: update(job_id, render={"status": "rendering", "message": m, "v": v}))
            entry = {"v": v, "at": time.time(), "dir": f"final/v{v}", **result}
            with lock:
                f = JOBS / job_id / "job.json"
                job = json.loads(f.read_text())
                renders = job.setdefault("renders", [])
                renders.append(entry)
                for old in renders[:-KEEP_MP4_VERSIONS]:
                    mp4 = JOBS / job_id / old["dir"] / "final.mp4"
                    if mp4.exists():
                        mp4.unlink()
                    old["mp4_removed"] = True
                job["render"] = {"status": "done", "message": f"Version {v} ready", **entry}
                f.write_text(json.dumps(job, indent=1))
        except Exception as e:
            traceback.print_exc()
            update(job_id, render={"status": "error", "message": f"{type(e).__name__}: {e}", "v": v})


def create_job(name, video_path):
    job_id = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
    (JOBS / job_id / "takes").mkdir(parents=True)
    job = {"id": job_id, "key": secrets.token_urlsafe(12), "name": name, "video": str(video_path),
           "created": time.time(), "status": "queued", "message": "Waiting to start", "lines": [],
           "takes": {}, "render": None, "sync_offset_ms": 0}
    save(job)
    threading.Thread(target=run_prepare, args=(job_id,), daemon=True).start()
    return job


# ---------------------------------------------------------------- owner API

@app.get("/api/jobs")
def list_jobs():
    jobs = [json.loads(p.read_text()) for p in JOBS.glob("*/job.json")]
    jobs.sort(key=lambda j: j["created"], reverse=True)
    return [{**public(j), "lines": len(j["lines"]),
             "recorded": sum(1 for t in j["takes"].values() if t.get("chosen")),
             "flags_open": sum(1 for f in j.get("flags", {}).values() if f["status"] == "open"),
             "flags_redone": sum(1 for f in j.get("flags", {}).values() if f["status"] == "re-recorded")}
            for j in jobs]


@app.post("/api/jobs")
async def upload_job(file: UploadFile = File(...)):
    tmp_dir = JOBS / "_uploads"
    tmp_dir.mkdir(exist_ok=True)
    dest = tmp_dir / f"{secrets.token_hex(4)}_{Path(file.filename).name}"
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f, length=8 * 1024 * 1024)
    return public(create_job(Path(file.filename).stem, dest))


class ImportBody(BaseModel):
    path: str


@app.post("/api/jobs/import")
def import_job(body: ImportBody):
    """Local-only shortcut: use a video already on this PC without copying it."""
    p = Path(body.path.strip().strip('"'))
    if not p.is_file():
        raise HTTPException(400, f"file not found: {p}")
    return public(create_job(p.stem, p))


@app.post("/api/jobs/{job_id}/retry")
def retry(job_id: str):
    job = load(job_id)
    if job["status"] != "error":
        raise HTTPException(400, "job is not in error state")
    update(job_id, status="queued", message="Retrying")
    threading.Thread(target=run_prepare, args=(job_id,), daemon=True).start()
    return {"ok": True}


# ---------------------------------------------------------------- studio API (needs the job key)

@app.get("/api/studio/{job_id}")
def studio_job(job_id: str, key: str):
    job = load(job_id)
    check_key(job, key)
    return public(job)


@app.post("/api/studio/{job_id}/takes")
async def add_take(job_id: str, key: str, line_id: str = Form(...), offset: float = Form(...),
                   duration: float = Form(...), file: UploadFile = File(...)):
    job = load(job_id)
    check_key(job, key)
    if not any(l["id"] == line_id for l in job["lines"]):
        raise HTTPException(400, "unknown line")
    data = await file.read()
    with lock:
        f = JOBS / job_id / "job.json"
        job = json.loads(f.read_text())
        st = _store_take(job, line_id, data, offset, duration)
        f.write_text(json.dumps(job, indent=1))
    return st


def _store_take(job, line_id, wav_bytes, offset, duration, run=False):
    """Save a take file, make it the chosen take, and mark a redo flag as re-recorded. Call under lock."""
    st = job["takes"].setdefault(line_id, {"takes": [], "chosen": None, "nudge": 0.0})
    n = max([t["n"] for t in st["takes"]], default=0) + 1
    name = f"{line_id}_take{n}.wav"
    (JOBS / job["id"] / "takes" / name).write_bytes(wav_bytes)
    st["takes"].append({"n": n, "file": name, "offset": offset, "duration": duration, "at": time.time(), "run": run})
    st["chosen"] = n
    st["nudge"] = 0.0
    flag = job.get("flags", {}).get(line_id)
    if flag and flag["status"] == "open":
        flag.update(status="re-recorded", take=n, rerecorded_at=time.time())
    return st


@app.post("/api/studio/{job_id}/runs")
async def add_run(job_id: str, key: str, offset: float = Form(...), file: UploadFile = File(...)):
    """One continuous recording across several lines; split it into one take per line."""
    job = load(job_id)
    check_key(job, key)
    run, sr = sf.read(io.BytesIO(await file.read()), dtype="float32")
    pieces = pipeline.split_run(run, sr, offset, job["lines"])
    if not pieces:
        raise HTTPException(400, "The run did not cover a whole line. Record a bit longer.")
    updated = {}
    with lock:
        f = JOBS / job_id / "job.json"
        job = json.loads(f.read_text())
        for line_id, start, seg in pieces:
            buf = io.BytesIO()
            sf.write(buf, seg, sr, format="WAV", subtype="PCM_16")
            updated[line_id] = _store_take(job, line_id, buf.getvalue(), round(start, 4), len(seg) / sr, run=True)
        f.write_text(json.dumps(job, indent=1))
    return {"takes": updated, "flags": job.get("flags", {})}


class Flag(BaseModel):
    note: str = ""


@app.put("/api/studio/{job_id}/flags/{line_id}")
def set_flag(job_id: str, line_id: str, key: str, body: Flag):
    job = load(job_id)
    check_key(job, key)
    if not any(l["id"] == line_id for l in job["lines"]):
        raise HTTPException(400, "unknown line")
    with lock:
        f = JOBS / job_id / "job.json"
        job = json.loads(f.read_text())
        job.setdefault("flags", {})[line_id] = {"note": body.note.strip(), "status": "open", "at": time.time()}
        f.write_text(json.dumps(job, indent=1))
    return job["flags"]


@app.delete("/api/studio/{job_id}/flags/{line_id}")
def clear_flag(job_id: str, line_id: str, key: str):
    check_key(load(job_id), key)
    with lock:
        f = JOBS / job_id / "job.json"
        job = json.loads(f.read_text())
        job.setdefault("flags", {}).pop(line_id, None)
        f.write_text(json.dumps(job, indent=1))
    return job["flags"]


class LineState(BaseModel):
    chosen: int | None = None
    nudge: float | None = None


@app.put("/api/studio/{job_id}/lines/{line_id}")
def set_line(job_id: str, line_id: str, key: str, body: LineState):
    job = load(job_id)
    check_key(job, key)
    with lock:
        f = JOBS / job_id / "job.json"
        job = json.loads(f.read_text())
        st = job["takes"].get(line_id)
        if not st:
            raise HTTPException(400, "no takes for this line")
        if body.chosen is not None:
            if not any(t["n"] == body.chosen for t in st["takes"]):
                raise HTTPException(400, "unknown take")
            st["chosen"] = body.chosen
        if body.nudge is not None:
            st["nudge"] = max(-2.0, min(2.0, body.nudge))
        f.write_text(json.dumps(job, indent=1))
    return st


class Settings(BaseModel):
    sync_offset_ms: float


@app.put("/api/studio/{job_id}/settings")
def set_settings(job_id: str, key: str, body: Settings):
    check_key(load(job_id), key)
    return public(update(job_id, sync_offset_ms=body.sync_offset_ms))


@app.post("/api/studio/{job_id}/submit")
def submit(job_id: str, key: str):
    job = load(job_id)
    check_key(job, key)
    if job["status"] != "ready":
        raise HTTPException(400, "job is not ready")
    if (job.get("render") or {}).get("status") == "rendering":
        raise HTTPException(400, "already rendering")
    update(job_id, render={"status": "queued", "message": "Waiting to render"}, submitted=time.time())
    threading.Thread(target=run_render, args=(job_id,), daemon=True).start()
    return {"ok": True}


# ---------------------------------------------------------------- files + pages

ALLOWED = {"proxy.mp4", "guide.m4a", "vo_peaks.json", "bed_peaks.json", "bed.wav", "vo.wav"}


@app.get("/files/{job_id}/{name:path}")
def job_file(job_id: str, name: str, key: str):
    job = load(job_id)
    check_key(job, key)
    base = job_path(job_id).resolve()
    p = (base / name).resolve()
    if base not in p.parents or not p.is_file():
        raise HTTPException(404, "no such file")
    if not (name in ALLOWED or name.startswith("takes/") or name.startswith("final/")):
        raise HTTPException(404, "no such file")
    return FileResponse(p)


@app.get("/")
def home():
    return RedirectResponse("/index.html")


app.mount("/", StaticFiles(directory=WEB), name="web")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8790)
