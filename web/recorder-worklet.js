// Copies raw mic samples to the main thread with the audio-clock time of each block.
class Recorder extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this.port.postMessage({ t: currentTime, frame: currentFrame, data: ch.slice(0) });
    }
    return true;
  }
}
registerProcessor("recorder", Recorder);
