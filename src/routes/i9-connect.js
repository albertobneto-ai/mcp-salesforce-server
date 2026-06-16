import express from 'express';

const router = express.Router();

/* ───────────────────────────────────────────────
   POST /api/i9-connect/transcribe
   Body: { audio: <base64>, mimeType, language }
   ─────────────────────────────────────────────── */
router.post('/transcribe', async (req, res) => {
  try {
    const { audio, mimeType, language } = req.body;
    if (!audio) return res.status(400).json({ error: 'audio (base64) is required' });

    const grokKey = process.env.GROK_KEY;
    if (!grokKey) return res.status(500).json({ error: 'GROK_KEY not configured on Heroku' });

    const audioBuffer = Buffer.from(audio, 'base64');
    const mime = mimeType || 'audio/webm';
    const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm';

    const blob = new Blob([audioBuffer], { type: mime });
    const formData = new FormData();
    formData.append('file', blob, `recording.${ext}`);
    formData.append('model', 'whisper-large-v3');
    formData.append('language', language || 'pt');
    formData.append('response_format', 'verbose_json');

    console.log(`[i9-connect] Transcribing ${(audioBuffer.length / 1024).toFixed(0)}KB ${mime} lang=${language || 'pt'}`);

    const xaiRes = await fetch('https://api.x.ai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${grokKey}` },
      body: formData
    });

    if (!xaiRes.ok) {
      const errBody = await xaiRes.text();
      console.error('[i9-connect] xAI error:', xaiRes.status, errBody);
      return res.status(xaiRes.status).json({ error: 'Transcription failed', details: errBody });
    }

    const result = await xaiRes.json();
    console.log(`[i9-connect] OK — ${(result.duration || 0).toFixed(1)}s transcribed`);

    res.json({
      text: result.text || '',
      language: result.language || language || 'pt',
      duration: result.duration || 0,
      segments: result.segments || []
    });
  } catch (err) {
    console.error('[i9-connect] error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* Health */
router.get('/health', (req, res) => {
  res.json({ status: 'ok', module: 'i9-connect', features: ['transcribe'] });
});

export default router;
