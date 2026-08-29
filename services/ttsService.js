/**
 * Text-to-Speech Service
 * Uses Google Translate TTS API (free, no key required)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Cache for generated TTS files
const ttsCache = new Map();

/**
 * Generate TTS audio from text using Google Translate TTS
 * @param {string} text - Text to convert to speech
 * @param {string} lang - Language code (default: Indonesian)
 * @returns {Promise<string|null>} - Local file path or null if failed
 */
async function generateTTS(text, lang = 'id-ID') {
  // Check cache first
  const cacheKey = `${text}_${lang}`;
  if (ttsCache.has(cacheKey)) {
    return ttsCache.get(cacheKey);
  }

  try {
    console.log(`[TTS] Generating speech: "${text.substring(0, 50)}..."`);
    
    // Use Google Translate TTS API
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(text)}`;
    
    const audioBuffer = await downloadAudio(url);
    
    if (!audioBuffer || audioBuffer.length === 0) {
      console.warn('[TTS] Empty audio response');
      return null;
    }
    
    // Save to temp file
    const filename = `tts_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.mp3`;
    const filepath = path.join(__dirname, '../../temp', filename);
    
    // Ensure temp directory exists
    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    fs.writeFileSync(filepath, audioBuffer);
    console.log(`[TTS] Audio saved: ${filepath}`);
    
    // Cache the result
    ttsCache.set(cacheKey, filepath);
    
    return filepath;
  } catch (error) {
    console.error('[TTS] Error:', error.message);
    return null;
  }
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
async function generateSceneAudio(scenes, lang = 'id-ID') {
  const results = [];
  
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    console.log(`[TTS] Generating scene ${i + 1}/${scenes.length}...`);
    
    try {
      const audioPath = await generateTTS(scene.narration, lang);
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
  const tempDir = path.join(__dirname, '../../temp');
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
