/**
 * Tab Audio Capture Patch
 * Uses getDisplayMedia to capture the tab's audio output (including WebRTC).
 * Chrome must be started with --auto-select-desktop-capture-source="Discord"
 * to auto-approve the capture without user interaction.
 *
 * API:
 *   window.__audioCapture.init()             → starts tab audio capture (call once)
 *   window.__audioCapture.startRecording()   → starts recording
 *   window.__audioCapture.stopRecording()    → returns Promise<string> (base64 webm)
 *   window.__audioCapture.getState()         → state object
 */
(() => {
  if (window.__audioCapture) return 'already-injected';

  const state = {
    stream: null,
    recorder: null,
    chunks: [],
    phase: 'idle', // idle → capturing → recording → stopped
    error: null,
  };

  async function init() {
    if (state.stream) return 'already-initialized';
    try {
      // Request tab audio capture
      // --auto-select-desktop-capture-source="Discord" auto-approves this
      state.stream = await navigator.mediaDevices.getDisplayMedia({
        video: false,  // We only want audio
        audio: {
          channelCount: 1,
          sampleRate: 48000,
        },
        preferCurrentTab: true,
      });
      
      const audioTracks = state.stream.getAudioTracks();
      console.log('[AudioCapture] Tab audio stream acquired, tracks:', audioTracks.length);
      
      if (audioTracks.length === 0) {
        state.error = 'No audio tracks in captured stream';
        return 'no-audio-tracks';
      }
      
      state.phase = 'capturing';
      return 'initialized';
    } catch (err) {
      state.error = err.message;
      console.error('[AudioCapture] init failed:', err);
      return 'error: ' + err.message;
    }
  }

  function startRecording() {
    if (!state.stream) return 'not-initialized';
    if (state.phase === 'recording') return 'already-recording';

    state.chunks = [];
    
    const mimeTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
    ];
    
    let mimeType = '';
    for (const mt of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mt)) { mimeType = mt; break; }
    }
    if (!mimeType) return 'no-supported-mime';

    state.recorder = new MediaRecorder(state.stream, { mimeType });
    state.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) state.chunks.push(e.data);
    };
    
    state.recorder.start(500);
    state.phase = 'recording';
    console.log('[AudioCapture] Recording started, MIME:', mimeType);
    return 'recording';
  }

  function stopRecording() {
    return new Promise((resolve) => {
      if (!state.recorder || state.phase !== 'recording') {
        resolve(null);
        return;
      }

      state.recorder.onstop = async () => {
        if (state.chunks.length === 0) { resolve(null); return; }
        
        const blob = new Blob(state.chunks, { type: state.recorder.mimeType });
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        
        let binary = '';
        const sz = 8192;
        for (let i = 0; i < bytes.length; i += sz) {
          binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + sz, bytes.length)));
        }
        const b64 = btoa(binary);
        
        state.phase = 'capturing'; // Stream still alive, can record again
        state.chunks = [];
        state.recorder = null;
        
        console.log('[AudioCapture] Got audio, base64 length:', b64.length);
        resolve(b64);
      };

      state.recorder.stop();
    });
  }

  function cleanup() {
    if (state.recorder && state.phase === 'recording') {
      try { state.recorder.stop(); } catch(e) {}
    }
    if (state.stream) {
      state.stream.getTracks().forEach(t => t.stop());
      state.stream = null;
    }
    state.recorder = null;
    state.chunks = [];
    state.phase = 'idle';
    return 'cleaned';
  }

  window.__audioCapture = {
    init,
    startRecording,
    stopRecording,
    cleanup,
    getState: () => ({
      phase: state.phase,
      hasStream: !!state.stream,
      audioTracks: state.stream?.getAudioTracks()?.length ?? 0,
      chunks: state.chunks.length,
      error: state.error,
    }),
  };

  return 'injected';
})();
