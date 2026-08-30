/**
 * Text-to-Speech Service
 * Uses Google Translate TTS API (free, no key required)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

// Cache for generated TTS files
const ttsCache = new Map();

/**
 * Generate Neural TTS audio using Microsoft Edge Neural Voice
 * (id-ID-ArdiNeural for male, id-ID-GadisNeural for female)
 * with seamless fallback to Google Translate TTS.
 */
async function generateTTS(text, lang = 'id-ID', voiceStyle = 'Narrator Male') {
  if (!text || typeof text !== 'string') return null;
  const cleanText = text.trim();
  if (!cleanText) return null;

  // Check cache first
  const cacheKey = `${cleanText}_${lang}_${voiceStyle}`;
  if (ttsCache.has(cacheKey)) {
    return ttsCache.get(cacheKey);
  }

  const tempDir = path.join(__dirname, '../temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const uniqueId = `tts_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const filename = `${uniqueId}.mp3`;
  const filepath = path.join(tempDir, filename);
  const publicUrl = `/temp/${filename}`;

  // 1. Primary: Microsoft Edge Neural TTS (Ultra-natural human voice)
  try {
    const isFemale = voiceStyle?.toLowerCase().includes('female') || voiceStyle?.toLowerCase().includes('wanita') || voiceStyle?.toLowerCase().includes('gadis');
    const voiceName = isFemale ? 'id-ID-GadisNeural' : 'id-ID-ArdiNeural';
    
    console.log(`[TTS] Generating Microsoft Edge Neural TTS (${voiceName}): "${cleanText.substring(0, 50)}..."`);
    const edgeTts = new MsEdgeTTS();
    await edgeTts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    
    const result = await edgeTts.toFile(tempDir, uniqueId, cleanText);
    const generatedPath = path.join(tempDir, `${uniqueId}.mp3`);
    const defaultGenerated = path.join(tempDir, 'audio.mp3');

    if (fs.existsSync(generatedPath) && fs.statSync(generatedPath).size > 100) {
      console.log(`[TTS] Edge Neural TTS saved: ${publicUrl}`);
      ttsCache.set(cacheKey, publicUrl);
      return publicUrl;
    } else if (fs.existsSync(defaultGenerated) && fs.statSync(defaultGenerated).size > 100) {
      fs.renameSync(defaultGenerated, filepath);
      console.log(`[TTS] Edge Neural TTS saved: ${publicUrl}`);
      ttsCache.set(cacheKey, publicUrl);
      return publicUrl;
    }
  } catch (edgeErr) {
    console.warn('[TTS] Edge Neural TTS fallback triggered:', edgeErr.message);
  }

  // 2. Fallback: Google Translate TTS API (Lightweight, reliable)
  try {
    console.log(`[TTS] Generating Google TTS fallback: "${cleanText.substring(0, 50)}..."`);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(cleanText)}`;
    const audioBuffer = await downloadAudio(url);
    
    if (audioBuffer && audioBuffer.length > 0) {
      fs.writeFileSync(filepath, audioBuffer);
      console.log(`[TTS] Google TTS saved: ${publicUrl}`);
      ttsCache.set(cacheKey, publicUrl);
      return publicUrl;
    }
  } catch (googleErr) {
    console.error('[TTS] Google TTS error:', googleErr.message);
  }

  return null;
}

/**
 * Download audio from URL
 */
function downloadAudio(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'audio/mpeg'
      }
    }, (res) => {
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        downloadAudio(res.headers.location).then(resolve).catch(reject);
        return;
      }
      
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * Generate TTS for all scenes
 */
async function generateSceneAudio(scenes, lang = 'id-ID', voiceStyle = 'Narrator Male') {
  const results = [];
  
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    console.log(`[TTS] Generating scene ${i + 1}/${scenes.length} with style ${voiceStyle}...`);
    
    try {
      const audioPath = await generateTTS(scene.narration, lang, voiceStyle);
      results.push({
        audio_url: audioPath,
        duration: scene.duration_seconds
      });
    } catch (error) {
      console.warn(`[TTS] Scene ${i + 1} failed:`, error.message);
      results.push({
        audio_url: null,
        duration: scene.duration_seconds,
        error: error.message
      });
    }
    
    // Small delay between requests to avoid rate limiting
    if (i < scenes.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
  
  return results;
}

/**
 * Clean up old TTS files (called periodically)
 */
function cleanupOldFiles(maxAgeHours = 24) {
  const tempDir = path.join(__dirname, '../temp');
  if (!fs.existsSync(tempDir)) return;
  
  const cutoffTime = Date.now() - maxAgeHours * 60 * 60 * 1000;
  
  fs.readdirSync(tempDir)
    .filter(file => file.startsWith('tts_') && file.endsWith('.mp3'))
    .forEach(file => {
      const filepath = path.join(tempDir, file);
      const stats = fs.statSync(filepath);
      if (stats.mtimeMs < cutoffTime) {
        fs.unlinkSync(filepath);
        console.log(`[TTS] Cleaned up old file: ${file}`);
      }
    });
}

module.exports = {
  generateTTS,
  generateSceneAudio,
  cleanupOldFiles
};
