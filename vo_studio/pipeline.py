"""Audio/video processing for VO Studio.

Every step takes file paths in and writes file paths out, so the same code can run
locally (FastAPI server) or inside a RunPod serverless handler later.
"""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ENV = Path(sys.executable).parent
SEPARATOR_BIN = str(ENV / ("audio-separator.exe" if os.name == "nt" else "audio-separator"))
MODEL_DIR = os.environ.get("VO_MODEL_DIR", str(Path(sys.executable).parent.parent / "models"))
WHISPER_MODEL = os.environ.get("VO_WHISPER_MODEL", "small.en")
SEP_PRESET = os.environ.get("VO_SEP_PRESET", "instrumental_clean")

CHUNK_S, PAD_S = 60.0, 3.0   # separation chunk length and overlap pad (RAM-safe on CPU)
PEAKS_PER_S = 100            # waveform resolution sent to the browser


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def ffmpeg(*args):
    run(["ffmpeg", "-v", "error", "-y", *args])


def probe_duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", str(path)], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def measure_lufs(path):
    """Integrated loudness (LUFS) of an audio file, via ffmpeg's EBU R128 meter."""
    out = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128=framelog=quiet",
                          "-f", "null", "-"], capture_output=True, text=True)
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", out.stderr)
    return float(m[-1]) if m else None


# ---------------------------------------------------------------- step 1: audio

def extract_audio(video, out_wav):
    ffmpeg("-i", str(video), "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", str(out_wav))


def make_proxy(video, bed_wav, out_mp4):
    """720p studio video with the no-VO bed as its audio track (light enough to stream)."""
    ffmpeg("-i", str(video), "-i", str(bed_wav), "-map", "0:v:0", "-map", "1:a:0",
           "-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
           "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", "-shortest", str(out_mp4))


def make_guide(vo_wav, out_m4a):
    ffmpeg("-i", str(vo_wav), "-ac", "1", "-c:a", "aac", "-b:a", "96k", "-ar", "48000", str(out_m4a))


# ---------------------------------------------------------------- step 2: separation

def separate(audio_wav, work_dir, bed_out, vo_out, progress=lambda msg: None):
    """Split the mix into bed (music + SFX) and VO.

    Runs the Roformer ensemble on overlapping chunks (the full file does not fit in RAM on CPU)
    and crossfades them back. VO = mix - bed, so the two stems always sum back to the original.
    """
    work_dir = Path(work_dir)
    (work_dir / "in").mkdir(parents=True, exist_ok=True)
    (work_dir / "out").mkdir(exist_ok=True)
    mix, sr = sf.read(audio_wav)
    dur = len(mix) / sr
    starts = np.arange(0, dur, CHUNK_S)
    for i, s in enumerate(starts):
        a, b = max(0, s - PAD_S), min(dur, s + CHUNK_S + PAD_S)
        sf.write(work_dir / "in" / f"c{i:03d}.wav", mix[int(a * sr):int(b * sr)], sr)
    for i in range(len(starts)):
        progress(f"Removing VO: part {i + 1} of {len(starts)}")
        name = f"c{i:03d}"
        if list((work_dir / "out").glob(f"{name}_*")):
            continue
        run([SEPARATOR_BIN, str(work_dir / "in" / f"{name}.wav"), "--ensemble_preset", SEP_PRESET,
             "--model_file_dir", MODEL_DIR, "--output_dir", str(work_dir / "out"),
             "--output_format", "WAV", "--single_stem", "Instrumental"])
    bed = np.zeros_like(mix)
    weight = np.zeros(len(mix))
    fade = int(PAD_S * sr)
    for i, s in enumerate(starts):
        y, _ = sf.read(next((work_dir / "out").glob(f"c{i:03d}_*")))
        a = int(max(0, s - PAD_S) * sr)
        n = min(len(y), len(mix) - a)
        w = np.ones(n)
        if i > 0:
            w[:2 * fade] = np.linspace(0, 1, 2 * fade)
        if i < len(starts) - 1:
            w[-2 * fade:] = np.minimum(w[-2 * fade:], np.linspace(1, 0, 2 * fade))
        bed[a:a + n] += y[:n] * w[:, None]
        weight[a:a + n] += w
    bed /= np.maximum(weight, 1e-6)[:, None]
    sf.write(bed_out, bed, sr, subtype="PCM_24")
    sf.write(vo_out, mix - bed, sr, subtype="PCM_24")


# ---------------------------------------------------------------- step 3: script lines

def transcribe_lines(vo_wav, progress=lambda msg: None):
    """Transcribe the old VO and cut it into recordable lines (sentence / pause boundaries)."""
    from faster_whisper import WhisperModel
    progress("Writing the timed script")
    import torch
    device = os.environ.get("VO_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
    model = WhisperModel(WHISPER_MODEL, device=device, compute_type="int8")
    # Decode with ffmpeg ourselves: faster-whisper's own decoder breaks with newer PyAV versions.
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", str(vo_wav), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    audio = np.frombuffer(pcm, dtype=np.float32)
    segments, _ = model.transcribe(audio, language="en", word_timestamps=True, vad_filter=False,
                                   condition_on_previous_text=False)
    words = [(w.word.strip(), w.start, w.end) for seg in segments for w in (seg.words or []) if w.word.strip()]
    return group_words(words)


def group_words(words, limit=12.0):
    """Group (word, start, end) tuples into recordable lines: sentence ends, long pauses, commas in long lines."""
    groups, cur = [], []

    def split_long(g):
        # Whisper sometimes drops punctuation in fast passages. Split at a pause, preferring
        # punctuation and the middle of the line so both halves stay readable.
        dur = g[-1][2] - g[0][1]
        if dur <= limit or len(g) < 4:
            return [g]
        best, score = None, -1e9
        for i in range(1, len(g)):
            t = g[i][1]
            if t - g[0][1] < 2.5 or g[-1][2] - t < 2.5:
                continue
            s = (g[i][1] - g[i - 1][2]) + (0.35 if g[i - 1][0][-1:] in ".?!,;:" else 0.0) \
                - 0.3 * abs((t - g[0][1]) / dur - 0.5) * 2
            if s > score:
                best, score = i, s
        if best is None:
            return [g]
        return split_long(g[:best]) + split_long(g[best:])

    def flush():
        if cur:
            groups.extend(split_long(list(cur)))
            cur.clear()

    for w in words:
        if cur:
            gap = w[1] - cur[-1][2]
            length = cur[-1][2] - cur[0][1]
            sentence_end = cur[-1][0].endswith((".", "?", "!"))
            comma = cur[-1][0].endswith((",", ";", ":"))
            if (gap > 0.6 or (sentence_end and length > 2.0) or (comma and length > 7.0 and gap > 0.12)
                    or (length > 10.0 and gap > 0.2)):
                flush()
        cur.append(w)
    flush()
    return [{"id": f"L{i + 1:03d}", "start": round(max(0, g[0][1] - 0.05), 3), "end": round(g[-1][2] + 0.1, 3),
             "text": re.sub(r" (?=[-'’.,!?;:%])", "", " ".join(w[0] for w in g)),
             "words": [[w[0], round(w[1], 3), round(w[2], 3)] for w in g]}
            for i, g in enumerate(groups)]


# ---------------------------------------------------------------- step 4: waveforms for the browser

def peaks(wav, out_json):
    x, sr = sf.read(wav)
    x = np.abs(x.mean(1) if x.ndim > 1 else x)
    hop = sr // PEAKS_PER_S
    n = len(x) // hop
    p = x[:n * hop].reshape(n, hop).max(1)
    p = np.clip(np.round(p / max(p.max(), 1e-6) * 127), 0, 127).astype(int)
    Path(out_json).write_text(json.dumps({"rate": PEAKS_PER_S, "peaks": p.tolist()}))


# ---------------------------------------------------------------- step 5: final render

def _trim_take(y, sr):
    """Cut room noise before/after the spoken part of a take; returns (start_index, audio)."""
    hop = int(sr * 0.01)
    n = len(y) // hop
    if n == 0:
        return 0, y
    env = 20 * np.log10(np.sqrt((y[:n * hop].reshape(n, hop) ** 2).mean(1)) + 1e-9)
    loud = np.where(env > env.max() - 35)[0]
    if len(loud) == 0:
        return 0, y[:0]
    pad = int(sr * 0.15)
    a = max(0, loud[0] * hop - pad)
    b = min(len(y), (loud[-1] + 1) * hop + pad)
    seg = y[a:b].copy()
    f = min(int(sr * 0.03), len(seg) // 2)
    if f:
        seg[:f] *= np.linspace(0, 1, f)
        seg[-f:] *= np.linspace(1, 0, f)
    return a, seg


def render(job_dir, job, video, out_dir, progress=lambda msg: None):
    """Place the chosen takes on the timeline, match the old VO loudness, mix with the bed, mux.

    The video stream is copied untouched (no re-encode), so picture quality is identical.
    """
    job_dir = Path(job_dir)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    dur = probe_duration(job_dir / "bed.wav")
    sr = 48000
    vo = np.zeros(int(dur * sr) + sr)
    placed, missing = 0, []
    progress("Placing takes")
    for line in job["lines"]:
        st = job["takes"].get(line["id"])
        take = next((t for t in (st or {}).get("takes", []) if t["n"] == (st or {}).get("chosen")), None)
        if not take:
            missing.append(line["id"])
            continue
        y, tsr = sf.read(job_dir / "takes" / take["file"])
        if y.ndim > 1:
            y = y.mean(1)
        if tsr != sr:
            idx = np.arange(0, len(y), tsr / sr)
            y = np.interp(idx, np.arange(len(y)), y)
        a, seg = _trim_take(y, sr)
        pos = int(round((take["offset"] + st.get("nudge", 0.0)) * sr)) + a
        if pos < 0:
            seg, pos = seg[-pos:], 0
        seg = seg[:max(0, len(vo) - pos)]
        vo[pos:pos + len(seg)] += seg
        placed += 1
    raw = out / "vo_new_raw.wav"
    sf.write(raw, vo, sr, subtype="FLOAT")

    progress("Matching the old VO loudness")
    proc = out / "vo_new_proc.wav"
    ffmpeg("-i", str(raw), "-af", "highpass=f=70,acompressor=threshold=-20dB:ratio=2.5:attack=8:release=120:makeup=2",
           "-c:a", "pcm_f32le", str(proc))
    target = job.get("old_vo_lufs") or measure_lufs(job_dir / "vo.wav")
    have = measure_lufs(proc)
    gain = (target - have) if (target is not None and have is not None and have > -70) else 0.0
    vo_final = out / "vo_new.wav"
    ffmpeg("-i", str(proc), "-af", f"volume={gain:.2f}dB", "-c:a", "pcm_s24le", str(vo_final))

    progress("Mixing with music + SFX")
    mix = out / "mix.wav"
    ffmpeg("-i", str(job_dir / "bed.wav"), "-i", str(vo_final), "-filter_complex",
           "[0:a]aresample=48000[b];[1:a]aresample=48000,pan=stereo|c0=c0|c1=c0[v];"
           "[b][v]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.89:level=false[m]",
           "-map", "[m]", "-c:a", "pcm_s24le", str(mix))

    progress("Exporting video")
    final_mp4 = out / "final.mp4"
    ffmpeg("-i", str(video), "-i", str(mix), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
           "-c:a", "aac", "-b:a", "320k", "-shortest", "-movflags", "+faststart", str(final_mp4))
    for f in (raw, proc):
        f.unlink(missing_ok=True)
    return {"placed": placed, "missing": missing, "gain_db": round(gain, 2), "lufs": measure_lufs(mix)}


def split_run(run, sr, offset, lines, margin_before=1.0, margin_after=1.5):
    """Cut one continuous recording (several lines read in a row) into per-line takes.

    The artist reads in sync with the video, so each line's speech sits near that line's original
    timing. Cut points go at the quietest 20 ms between two lines (searched around the gap midpoint).
    Returns [(line_id, take_offset_seconds, samples)] for lines fully inside the recording.
    """
    if run.ndim > 1:
        run = run.mean(1)
    end = offset + len(run) / sr
    covered = [l for l in lines if l["start"] >= offset + 0.2 and l["end"] <= end - 0.1]
    if not covered:
        return []
    hop = int(sr * 0.02)

    def quietest(t0, t1):
        a, b = int((t0 - offset) * sr), int((t1 - offset) * sr)
        a, b = max(0, a), min(len(run), b)
        n = (b - a) // hop
        if n < 1:
            return (t0 + t1) / 2
        rms = np.sqrt((run[a:a + n * hop].reshape(n, hop) ** 2).mean(1))
        return offset + (a + (int(np.argmin(rms)) + 0.5) * hop) / sr

    cuts = []
    for a, b in zip(covered, covered[1:]):
        if lines.index(b) != lines.index(a) + 1 or b["start"] - a["end"] > 2 * margin_after:
            cuts.append((a["end"] + margin_after, b["start"] - margin_before))
            continue
        mid = (a["end"] + b["start"]) / 2
        t = quietest(max(a["end"] - 0.15, mid - 0.5), min(b["start"] + 0.15, mid + 0.5))
        cuts.append((t, t))
    starts = [max(offset, covered[0]["start"] - margin_before)] + [c[1] for c in cuts]
    ends = [c[0] for c in cuts] + [min(end, covered[-1]["end"] + margin_after)]
    out = []
    for line, s, e in zip(covered, starts, ends):
        seg = run[int((s - offset) * sr):int((e - offset) * sr)]
        if len(seg) > sr * 0.3:
            out.append((line["id"], s, seg))
    return out


# ---------------------------------------------------------------- whole prep step

def prepare(job_dir, video, progress=lambda msg: None):
    """Video in, studio-ready job out: bed.wav, vo.wav, lines, waveforms, proxy, guide."""
    job_dir = Path(job_dir)
    audio = job_dir / "audio.wav"
    if not audio.exists():
        progress("Extracting audio")
        extract_audio(video, audio)
    if not (job_dir / "bed.wav").exists():
        separate(audio, job_dir / "sep_chunks", job_dir / "bed.wav", job_dir / "vo.wav", progress)
        shutil.rmtree(job_dir / "sep_chunks", ignore_errors=True)
    lines_file = job_dir / "lines.json"
    if not lines_file.exists():
        lines_file.write_text(json.dumps(transcribe_lines(job_dir / "vo.wav", progress), indent=1))
    progress("Drawing waveforms")
    peaks(job_dir / "vo.wav", job_dir / "vo_peaks.json")
    peaks(job_dir / "bed.wav", job_dir / "bed_peaks.json")
    if not (job_dir / "guide.m4a").exists():
        make_guide(job_dir / "vo.wav", job_dir / "guide.m4a")
    if not (job_dir / "proxy.mp4").exists():
        progress("Making the studio video")
        make_proxy(video, job_dir / "bed.wav", job_dir / "proxy.mp4")
    return {"lines": json.loads(lines_file.read_text()), "duration": probe_duration(audio),
            "old_vo_lufs": measure_lufs(job_dir / "vo.wav")}
