# VO Studio

Replace the voiceover in a finished video when the edit project is lost.

1. **Dashboard** (`/index.html`): drop a video. The app removes the old VO (Roformer ensemble),
   transcribes it into timed lines (faster-whisper) and gives you a studio link.
2. **Studio** (`/studio.html?job=…&key=…`): the VO artist sees the video, the old VO waveform and a
   teleprompter, records each line on time (pre-roll, countdown, unlimited takes), picks takes and
   drags them to fix timing. Progress is saved on the server, so he can stop and come back.
3. **Render**: on submit, chosen takes are trimmed, placed, loudness-matched to the old VO, mixed
   with the music + SFX bed and muxed onto the original video (video stream copied, not re-encoded).

## Install and run (Windows)

1. Install [Python 3.11+](https://www.python.org/downloads/) and ffmpeg (`winget install Gyan.FFmpeg`).
2. Clone this repo to a short path, e.g. `C:\vo-studio` (deep folders can hit the Windows path limit).
3. Double-click `setup.bat` once. It installs the AI tools (about 3 GB).
4. Double-click `start.bat`. The dashboard opens at http://localhost:8790.

## Workflow when the VO artist runs it on his own PC

1. Get the original video file (Drive, WeTransfer…).
2. On the dashboard, drop the video or paste its path. Wait for "Ready" (CPU: about 1 hour for 10 minutes of video, mostly VO removal).
3. Click **Open studio**, put on headphones, open **Mic & sync**, record (**R** = one line, **Shift+R** = run through several lines).
4. Back on the dashboard, click **Render new version** and send back `Final video.mp4` and `New VO.wav`.

Use Chrome. Recording needs headphones so the video sound does not leak into the mic.

## Layout

- `vo_studio/pipeline.py`: all audio/video processing (paths in, paths out). Reused by the RunPod worker later.
- `vo_studio/server.py`: local FastAPI server (jobs, takes, render queue, file serving).
- `web/`: static pages (dashboard, studio). No build step, so they deploy to Netlify as-is.
- `data/jobs/<id>/`: one folder per job (stems, lines, takes, final render).

## Settings (environment variables)

- `VO_SEP_PRESET`: separation ensemble, default `instrumental_clean`.
- `VO_WHISPER_MODEL`: default `small.en`.
- `VO_DEVICE`: `cpu` or `cuda` (auto-detected).

## Notes

- On a CPU the VO removal takes about 6 minutes per minute of video. On a RunPod GPU it takes seconds.
- Recording needs headphones and works best in Chrome. Browser voice processing (echo cancellation,
  noise suppression, auto gain) is switched off, and takes are saved as uncompressed WAV.
