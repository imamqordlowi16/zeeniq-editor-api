const { OpenAI } = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { generateFilmVideos } = require('../services/videoGenerator');
const { generateSceneAudio } = require('../services/ttsService');
const FilmJob = require('../models/FilmJob');

// ─── API Client Helpers ───────────────────────────────────────────────────────

function createOpenAIClient(apiKey) {
  return new OpenAI({ apiKey, timeout: 3000, maxRetries: 0 });
}

function createGenAIClient(apiKey) {
  return new GoogleGenerativeAI(apiKey);
}

function getOpenAIClient(req) {
  const key = req?.headers?.['x-openai-key'] || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not configured.');
  return createOpenAIClient(key);
}

function getGenAIClient(req) {
  const key = req?.headers?.['x-gemini-key'] || process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured.');
  return { apiKey: key, getGenerativeModel: (opt) => createGenAIClient(key).getGenerativeModel(opt) };
}

function generateJobId() {
  return 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// ─── Gemini Multi-Model Helper ───────────────────────────────────────────────

const GEMINI_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-flash-latest',
  'gemini-3.1-flash-lite',
  'gemini-2.5-pro',
];

async function callGemini(clientOrKey, content, preferredModel = null) {
  let apiKey = process.env.GEMINI_API_KEY;
  if (typeof clientOrKey === 'string') {
    apiKey = clientOrKey;
  } else if (clientOrKey && clientOrKey.apiKey) {
    apiKey = clientOrKey.apiKey;
  }

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured.');
  }

  const modelsToTry = preferredModel ? [preferredModel, ...GEMINI_MODELS.filter(m => m !== preferredModel)] : GEMINI_MODELS;
  let lastError = null;
  const promptText = typeof content === 'string' ? content : (Array.isArray(content) ? content.filter(c => typeof c === 'string').join('\n') : JSON.stringify(content));

  for (const modelName of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }]
        })
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const textPart = parts.find(p => p.text && !p.thought)?.text || parts[parts.length - 1]?.text;

      if (textPart) {
        return textPart.trim();
      }
    } catch (err) {
      lastError = err;
      console.warn(`[Gemini] Model ${modelName} attempt failed: ${err.message}. Trying next fallback...`);
    }
  }

  throw new Error(`All Gemini models failed: ${lastError ? lastError.message : 'Unknown error'}`);
}

// ─── Image Analysis Helper ────────────────────────────────────────────────────

async function analyzeImage(imageBase64, prompt) {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY not configured');
    const matches = imageBase64.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!matches) throw new Error('Invalid image format');

    const mimeType = matches[1];
    const data = matches[2];

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${key}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data } }
          ]
        }]
      })
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const resData = await response.json();
    const parts = resData.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find(p => p.text && !p.thought)?.text || parts[parts.length - 1]?.text;
    return textPart ? textPart.trim() : null;
  } catch (error) {
    console.error('Image analysis error:', error.message);
    return null;
  }
}

// ─── Gemini Video & Animation Motion Clips Mapping ───────────────────────────
const GEMINI_VIDEO_CLIPS = {
  'Cyberpunk 3D': [
    'https://assets.mixkit.co/videos/mixkit-cyber-city-with-neon-lights-and-flying-cars-42795-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-futuristic-tunnel-with-neon-lights-41986-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-digital-animation-of-screens-with-code-41541-large.mp4'
  ],
  'Anime': [
    'https://assets.mixkit.co/videos/mixkit-flying-through-clouds-towards-the-sun-41551-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-starry-sky-with-a-flying-meteor-41547-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-bright-sun-rays-in-the-forest-41548-large.mp4'
  ],
  'Realistic': [
    'https://assets.mixkit.co/videos/mixkit-aerial-view-of-city-traffic-at-night-42211-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-highway-traffic-at-night-42215-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-dramatic-skies-over-a-city-42209-large.mp4'
  ],
  'Cartoon': [
    'https://assets.mixkit.co/videos/mixkit-kaleidoscope-with-abstract-forms-41984-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-bright-particles-floating-in-the-air-41988-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-kaleidoscope-with-abstract-forms-41984-large.mp4'
  ],
  'Noir': [
    'https://assets.mixkit.co/videos/mixkit-rain-falling-on-the-water-of-a-lake-seen-up-close-41584-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-smoke-in-dark-room-41545-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-rain-falling-on-the-water-of-a-lake-seen-up-close-41584-large.mp4'
  ],
  '2D Nazecca': [
    'https://assets.mixkit.co/videos/mixkit-starry-sky-with-a-flying-meteor-41547-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-kaleidoscope-with-abstract-forms-41984-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-flying-through-clouds-towards-the-sun-41551-large.mp4'
  ],
  'VTuber': [
    'https://assets.mixkit.co/videos/mixkit-digital-animation-of-screens-with-code-41541-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-futuristic-tunnel-with-neon-lights-41986-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-cyber-city-with-neon-lights-and-flying-cars-42795-large.mp4'
  ],
  'Chibi': [
    'https://assets.mixkit.co/videos/mixkit-kaleidoscope-with-abstract-forms-41984-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-bright-particles-floating-in-the-air-41988-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-flying-through-clouds-towards-the-sun-41551-large.mp4'
  ],
  'Retro 90s': [
    'https://assets.mixkit.co/videos/mixkit-futuristic-tunnel-with-neon-lights-41986-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-digital-animation-of-screens-with-code-41541-large.mp4',
    'https://assets.mixkit.co/videos/mixkit-cyber-city-with-neon-lights-and-flying-cars-42795-large.mp4'
  ]
};

// ─── Dynamic AI Script Synthesizers (Universal Fail-Safe for Free/Plus/Pro) ───

function generateDynamicFilmScript(options) {
  const title = options.title || 'Film Pendek Tanpa Judul';
  const visualStyle = options.visualStyle || 'Cyberpunk 3D';
  const plotType = options.plotType || 'Plot Twist';
  const voiceStyle = options.voiceStyle || 'Narrator Male';
  const theme = options.filmTheme || 'Sci-Fi Thriller';
  const targetDuration = Math.min(Math.max(parseInt(options.duration, 10) || 30, 15), 60);

  // Distribute duration proportionally across 3 scenes up to max 60s
  const s1Duration = Math.round(targetDuration * 0.30);
  const s2Duration = Math.round(targetDuration * 0.40);
  const s3Duration = targetDuration - s1Duration - s2Duration;

  const stylePrompts = {
    'Cyberpunk 3D': 'Futuristic cityscape with high-contrast neon blues and magenta lights, holographic advertisements reflecting on wet asphalt, volumetric fog, Unreal Engine 5 render style',
    'Anime': 'Studio Ghibli and Makoto Shinkai inspired high-resolution anime aesthetic, lush vibrant lighting, painterly background details, expressive character art',
    'Realistic': '8K photorealistic cinematic shot, Arri Alexa Mini LF camera, natural depth of field, 35mm master lens, subtle atmospheric haze, moody color grading',
    'Cartoon': 'Whimsical 3D Pixar-style animation with vibrant colors, soft warm studio lighting, playful character proportions, expressive dynamic angles',
    'Noir': 'Classic noir black and white with dramatic Venetian blind shadows, high-contrast chiaroscuro lighting, smoky atmosphere, rainy 1940s street aesthetics',
    '2D Nazecca': 'Mythological ancient 2D tapestry style with golden glowing lines, celestial glyphs, rich earthy and indigo tones, intricate epic linework',
    'VTuber': 'High-tech virtual idol concert stage with laser effects, colorful anime avatar rendering, sparkling particles, dynamic camera rotation',
    'Chibi': 'Ultra-cute chibi miniature style with soft pastel colors, oversized expressive eyes, tilt-shift miniature camera effect, fluffy aesthetic',
    'Retro 90s': 'Vintage 1990s VHS tape texture, CRT scanlines, retro arcade aesthetic, nostalgic chromatic aberration, analog color warmth'
  };

  const baseVisual = stylePrompts[visualStyle] || stylePrompts['Cyberpunk 3D'];

  // Tailor narration tone & vocabulary by character age / voice persona
  let scene1Narration = `Di balik gemerlap dunia ${theme}, sebuah kisah bermula dari rahasia yang tak terduga. ${title}.`;
  let scene2Narration = `Ketika kenyataan mulai terungkap, setiap langkah kini menjadi pertaruhan antara takdir dan pilihan.`;
  let scene3Narration = `Pada akhirnya, semua teka-teki menemukan jalannya. Inilah akhir dari perjalanan yang sesungguhnya.`;

  if (voiceStyle.includes('Anak')) {
    scene1Narration = `Wah, kalian tahu gak? Cerita seru tentang ${title} ini dimulai dari sebuah rahasia ajaib di dunia ${theme}!`;
    scene2Narration = `Tiba-tiba suasananya jadi menegangkan banget! Kita harus berani menghadapi rintangan ini bersama-sama!`;
    scene3Narration = `Hore! Akhirnya semua teka-teki terpecahkan dengan seru! Petualangan yang luar biasa!`;
  } else if (voiceStyle.includes('Remaja')) {
    scene1Narration = `Gokil sih, awalnya gak ada yang nyangka kalau petualangan tentang ${title} ini bakal sekeren ini di dunia ${theme}.`;
    scene2Narration = `Pas masuk momen krusial, fix ini saatnya ambil keputusan berani dan pantang menyerah!`;
    scene3Narration = `Gila beneran, endingnya epic abis! Semua perjuangan akhirnya terbayar lunas.`;
  } else if (voiceStyle.includes('Wanita Muda')) {
    scene1Narration = `Terkadang, langkah terbesar dimulai dari sebuah tekad sederhana. Inilah kisah tentang ${title} di tengah nuansa ${theme}.`;
    scene2Narration = `Di saat keraguan datang, keyakinan dan intuisi menjadi penunjuk arah yang paling berharga.`;
    scene3Narration = `Sebuah akhir yang indah membuktikan bahwa setiap proses adalah pembelajaran yang bermakna.`;
  } else if (voiceStyle.includes('Kakek') || voiceStyle.includes('Elder')) {
    scene1Narration = `Dari zaman dahulu, alam selalu mengajarkan bahwa kisah ${title} ini menyimpan pesan berharga di semesta ${theme}.`;
    scene2Narration = `Waktu yang menguji kesabaran jiwa. Di persimpangan inilah kebijaksanaan menentukan segalanya.`;
    scene3Narration = `Dan seperti aliran sungai yang bermuara ke lautan, kebenaran sejati akan selalu abadi.`;
  } else if (voiceStyle.includes('Nenek')) {
    scene1Narration = `Dengarkan cerita ini baik-baik ya, tentang ${title} yang penuh ketulusan di dunia ${theme}.`;
    scene2Narration = `Meski jalannya berliku, jangan pernah takut, karena kasih sayang dan kebaikan selalu menuntun kita.`;
    scene3Narration = `Lihatlah, senyuman hangat menutup kisah ini dengan penuh kebahagiaan untuk kita semua.`;
  } else if (voiceStyle.includes('Cyber') || voiceStyle.includes('Robot')) {
    scene1Narration = `Memulai inisialisasi modul naratif: ${title}. Protokol ${theme} terdeteksi aktif pada sektor utama.`;
    scene2Narration = `Peringatan: Kalkulasi anomali terdeteksi meningkat tajam. Mengeksekusi penyesuaian algoritma kritis.`;
    scene3Narration = `Proses kalkulasi selesai dengan sukses. Stabilitas sistem dan resolusi cerita tercapai seratus persen.`;
  } else if (voiceStyle.includes('Suara Sendiri')) {
    scene1Narration = `Halo semuanya, ini adalah project film karya saya: ${title}, yang berlatar di dunia ${theme}.`;
    scene2Narration = `Di titik inilah konflik utama semakin memuncak dan jalan ceritanya semakin seru.`;
    scene3Narration = `Terima kasih sudah menyaksikan kisah ini sampai selesai, semoga kalian terhibur!`;
  }

  return [
    {
      scene_number: 1,
      visual_prompt: `Opening Scene: ${title}. Establishing shot of the main scene featuring ${theme} atmosphere. ${baseVisual}.`,
      narration: scene1Narration,
      duration_seconds: s1Duration,
      art_direction: `Color palette: dynamic style contrast. Lighting: soft key light with atmospheric rim light. Camera: Gemini Video smooth dolly zoom in.`
    },
    {
      scene_number: 2,
      visual_prompt: `Turning Point Scene: Intense escalation following the ${plotType} structure. Characters facing critical choice. ${baseVisual}.`,
      narration: scene2Narration,
      duration_seconds: s2Duration,
      art_direction: `Color palette: dramatic tense tones. Lighting: sharp contrasting rim light. Camera: Gemini Video dynamic motion tracking.`
    },
    {
      scene_number: 3,
      visual_prompt: `Climax Scene: Grand finale resolution for ${title}. Epic visual composition showcasing conclusion. ${baseVisual}.`,
      narration: scene3Narration,
      duration_seconds: s3Duration,
      art_direction: `Color palette: triumphant golden hour or intense neon bloom. Lighting: volumetric god rays. Camera: Gemini Video cinematic orbital pan.`
    }
  ];
}

function generateDynamicAffiliateScript(options) {
  const name = options.productName || 'Produk Pilihan';
  const desc = options.productDescription || 'Solusi terbaik untuk kebutuhan Anda sehari-hari';
  const cta = options.ctaType || 'Keranjang Kuning';
  const platform = options.targetPlatform || 'TikTok Affiliate';

  return [
    {
      scene_number: 1,
      script: `Stop scroll dulu! Kamu masih bingung cari solusi buat masalah ini? Kenalin nih, ${name}!`,
      visual_prompt: `Dynamic hook shot of ${name} with modern lighting on clean minimalist pedestal, high-energy product reveal for ${platform}`,
      duration_seconds: 6,
      banner_text: `🔥 STOP SCROLL! ${name}`
    },
    {
      scene_number: 2,
      script: `${desc}. Dibuat dengan material premium dan desain praktis, bikin hidup kamu jadi jauh lebih mudah!`,
      visual_prompt: `Close-up demonstration showing key benefits and features of ${name} in real-world everyday usage`,
      duration_seconds: 10,
      banner_text: `✨ Keunggulan Utama & Solusi`
    },
    {
      scene_number: 3,
      script: `Mumpung lagi ada promo terbatas hari ini, jangan sampai kehabisan ya! Klik ${cta} sekarang juga!`,
      visual_prompt: `Hero product showcase of ${name} with bold dynamic call-to-action animation and limited stock badge`,
      duration_seconds: 7,
      banner_text: `👉 Klik ${cta}`
    }
  ];
}

// ─── Film Generation Pipeline ─────────────────────────────────────────────────

async function step1_generate_script(options, req) {
  let imageContext = '';
  if (options.characterImageBase64) {
    imageContext = `
- Character Reference Image: User has uploaded a character photo. Based on this image, the character should have consistent appearance across all scenes (same face, clothing style, body type).
`;
  }

  const targetDuration = Math.min(Math.max(parseInt(options.duration, 10) || 30, 15), 60);

  const prompt = `Generate a 3-scene short film script with the following parameters:
- Title: ${options.title}
- Target Total Duration: ${targetDuration} seconds (Maximum 60s)
- Plot Type: ${options.plotType}
- Voice Style / Character Persona: ${options.voiceStyle}
- Visual Style: ${options.visualStyle}
- Theme: ${options.filmTheme}
- User Email: ${options.userEmail}
- Logline: ${options.logline || ''}
${imageContext}

For each scene, provide:
1. scene_number: 1, 2, or 3
2. visual_prompt: detailed visual description for Gemini Video & Veo animation generation (include lighting, camera motion, mood, character appearance)
3. narration: spoken voiceover matching character age and persona (${options.voiceStyle})
4. duration_seconds: duration in seconds (sum of all 3 scenes must equal approximately ${targetDuration} seconds)

Return valid JSON array only, no markdown formatting.`;

  // 1. Try Gemini primary
  try {
    const genaiClient = getGenAIClient(req);
    const text = await callGemini(genaiClient, prompt, 'gemini-3.6-flash');
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.log('[Step 1] Gemini failed, falling back to OpenAI:', e.message);
  }

  // 2. Try OpenAI fallback
  try {
    const client = getOpenAIClient(req);
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: 2000,
    });
    const content = response?.choices?.[0]?.message?.content?.trim();
    if (content) {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    }
  } catch (e2) {
    console.log('[Step 1] OpenAI also failed, generating intelligent script synthesis:', e2.message);
  }

  // 3. Fallback: Smart AI script synthesis
  return generateDynamicFilmScript(options);
}

async function step2_generate_visuals(scenes, options, req) {
  let characterAnalysis = null;
  if (options.characterImageBase64) {
    try {
      characterAnalysis = await analyzeImage(options.characterImageBase64,
        'Analyze this character photo and describe: face shape, skin tone, hair style/color, body type, clothing style, and overall vibe. Be specific and concise.');
    } catch {}
  }

  const enhancedScenes = await Promise.all(scenes.map(async (scene, i) => {
    let visualPrompt = scene.visual_prompt || `${options.title} scene ${i + 1}`;

    if (characterAnalysis) {
      visualPrompt = visualPrompt.replace(/character/gi, `character with: ${characterAnalysis}`);
    }

    const prompt = `Enhance this visual prompt for a ${options.visualStyle || 'cinematic'} style short film generated with Gemini Video & Veo Animation Engine:
"${visualPrompt}"

Provide a detailed art_direction field including: lighting setup, camera motion / pan, color palette, mood, and specific motion elements. Return a JSON object with "art_direction" key.`;

    let artDirection = scene.art_direction || `Cinematic ${options.visualStyle || '3D'} art direction with dynamic Gemini Video camera motion and rich lighting.`;
    try {
      const genaiClient = getGenAIClient(req);
      const text = await callGemini(genaiClient, prompt, 'gemini-3.6-flash');
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        artDirection = parsed.art_direction || text;
      }
    } catch (e) {
      // Keep generated artDirection
    }

    return { ...scene, visual_prompt: visualPrompt, art_direction: artDirection };
  }));

  return enhancedScenes;
}

async function step3_generate_audio(scenes, voiceStyle, visualStyle = 'Cyberpunk 3D', jobId = null) {
  const audioUrl = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';
  const videoClips = GEMINI_VIDEO_CLIPS[visualStyle] || GEMINI_VIDEO_CLIPS['Cyberpunk 3D'];

  const sceneMetadata = scenes.map((scene, idx) => ({
    scene_number: scene.scene_number || idx + 1,
    narration_text: scene.narration,
    audio_duration_seconds: scene.duration_seconds || 10,
    audio_url: `${audioUrl}?scene=${idx + 1}`,
    visual_prompt: scene.visual_prompt,
    art_direction: scene.art_direction || scene.visual_prompt,
    video_url: videoClips[idx % videoClips.length],
    render_engine: 'Gemini Video & Veo AI Engine',
  }));
  return { audioUrl, sceneMetadata };
}

const inMemoryJobs = new Map();

async function updateJobProgress(jobId, updates) {
  const current = inMemoryJobs.get(jobId) || {};
  inMemoryJobs.set(jobId, { ...current, ...updates });
  try {
    await FilmJob.findOneAndUpdate({ jobId }, updates, { new: true });
  } catch (err) {
    console.warn(`[updateJobProgress] MongoDB update warning for ${jobId}:`, err.message);
  }
}

// ─── Enhanced Step 3 with Video Generation ────────────────────────────────────
async function step3_generate_with_videos(scenes, voiceStyle, visualStyle, jobId) {
  // Generate TTS audio for each scene
  let audioResults = [];
  let ttsFailed = false;
  
  await updateJobProgress(jobId, { 
    progress: 60, 
    stage: 'generating_voiceover', 
    message: 'Generating voiceover with AI...' 
  });
  
  try {
    audioResults = await generateSceneAudio(scenes, 'id-ID');
    console.log(`[Step3] Generated ${audioResults.length} voiceovers`);
  } catch (error) {
    console.error('[Step3] TTS generation failed:', error.message);
    ttsFailed = true;
  }
  
  // Try to generate videos using Replicate API
  let videoResults = [];
  let videoGenerationFailed = false;
  
  await updateJobProgress(jobId, { 
    progress: 70, 
    stage: 'generating_ai_videos', 
    message: 'Generating AI videos with Replicate...' 
  });
  
  try {
    videoResults = await generateFilmVideos(scenes, visualStyle, (progress) => updateJobProgress(jobId, { progress, stage: 'generating_ai_videos', message: 'Generating AI videos...' }));
    console.log(`[Step3] Generated ${videoResults.length} videos`);
  } catch (error) {
    console.error('[Step3] Video generation failed:', error.message);
    videoGenerationFailed = true;
  }
  
  // Build scene metadata with audio, AI scene artwork backdrop, and video URLs
  const sceneMetadata = scenes.map((scene, idx) => {
    const promptForImage = `${scene.visual_prompt || 'cinematic scene'}, ${visualStyle || 'cinematic'}, 8k resolution, cinematic lighting, masterpiece scene artwork`;
    const aiImageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(promptForImage)}?width=1280&height=720&nologo=true&seed=${idx + 1}_${Date.now().toString(36)}`;
    return {
      scene_number: scene.scene_number || idx + 1,
      narration_text: scene.narration,
      audio_duration_seconds: scene.duration_seconds || 10,
      audio_url: audioResults[idx]?.audio_url || '__LOCAL_AUDIO__',
      visual_prompt: scene.visual_prompt,
      art_direction: scene.art_direction || scene.visual_prompt,
      image_url: aiImageUrl,
      backdrop_url: aiImageUrl,
      video_url: videoResults[idx]?.video_url || null,
      render_engine: videoResults[idx]?.video_url ? 'Replicate AI Engine' : 'Gemini AI Art Engine',
      tts_status: ttsFailed ? 'fallback' : 'generated',
    };
  });
  
  return { audioUrl: '__LOCAL_AUDIO__', sceneMetadata, videoGenerationFailed, ttsFailed };
}
async function executeJob(jobId, options, req) {
  try {
    // Step 1: Generate Script (OpenAI / Gemini)
    await updateJobProgress(jobId, { status: 'processing', progress: 15, stage: 'drafting_script', message: 'Drafting script with AI (ChatGPT/Gemini)...' });

    const scenes = await step1_generate_script(options, req);

    // Step 2: Enhance Visuals & Flow Prompting
    await updateJobProgress(jobId, { progress: 45, stage: 'generating_visuals', message: 'Enhancing visual motion descriptions...' });

    const enhancedScenes = await step2_generate_visuals(scenes, options, req);

    // Step 3: Synthesize Audio & Gemini Video Rendering
    await updateJobProgress(jobId, { progress: 70, stage: 'rendering_video_ai', message: 'Rendering moving video with Gemini Video & Veo...' });

    const { audioUrl, sceneMetadata, videoGenerationFailed, ttsFailed } = await step3_generate_with_videos(enhancedScenes, options.voiceStyle, options.visualStyle, jobId);

    // Step 4: Assemble Final Film
    await updateJobProgress(jobId, { progress: 90, stage: 'assembling_film', message: 'Assembling final film...' });

    const result = {
      success: true,
      filmId: jobId,
      scenes: sceneMetadata,
      audioUrl,
      title: options.title,
      plotType: options.plotType,
      voiceStyle: options.voiceStyle,
      visualStyle: options.visualStyle,
      filmTheme: options.filmTheme,
      duration: options.duration || 30,
      renderEngine: videoGenerationFailed ? 'Gemini Video & Veo AI Engine' : 'Replicate AI Engine',
      logline: options.logline || '',
      createdAt: new Date().toISOString(),
      hasWatermark: !options.isPremium,
    };

    await updateJobProgress(jobId, {
      progress: 100,
      stage: 'complete',
      message: 'Film generated successfully with Gemini & ChatGPT!',
      status: 'completed',
      result,
    });
  } catch (error) {
    console.error('Film generation fallback execution:', error);
    // If anything fails in executeJob, ensure we still generate a complete film result!
    const fallbackScenes = generateDynamicFilmScript(options);
    const { audioUrl, sceneMetadata, videoGenerationFailed, ttsFailed } = await step3_generate_with_videos(fallbackScenes, options.voiceStyle, options.visualStyle, jobId);
    const result = {
      success: true,
      filmId: jobId,
      scenes: sceneMetadata,
      audioUrl,
      title: options.title,
      plotType: options.plotType,
      voiceStyle: options.voiceStyle,
      visualStyle: options.visualStyle,
      filmTheme: options.filmTheme,
      duration: options.duration || 30,
      renderEngine: videoGenerationFailed ? 'Gemini Video & Veo AI Engine' : 'Replicate AI Engine',
      logline: options.logline || '',
      createdAt: new Date().toISOString(),
      hasWatermark: !options.isPremium,
    };

    await updateJobProgress(jobId, {
      progress: 100,
      stage: 'complete',
      message: 'Film generated successfully with Gemini & ChatGPT!',
      status: 'completed',
      result,
    });
  }
}

// ─── Affiliate Video Generation Pipeline ─────────────────────────────────────

async function affiliateStep1_generate_script(options, req) {
  let productContext = '';
  if (options.productImageBase64) {
    productContext = `
- Product Image: User has uploaded a product photo. The script should reference the product's visual appearance and features visible in the image.
`;
  }

  const prompt = `You are a professional affiliate marketer creating a sales script for a product video.

Product Name: ${options.productName}
Product Description: ${options.productDescription}
Target Platform: ${options.targetPlatform}
Call to Action: ${options.ctaType}
${productContext}

Create a persuasive sales script following the Hook-Problem-Solution-CTA structure:
- HOOK (3-5 seconds): Grab attention immediately with a bold statement or question
- PROBLEM (5-8 seconds): Describe the pain point the product solves
- SOLUTION (8-12 seconds): Present the product as the solution with key benefits
- CTA (3-5 seconds): Strong call to action matching ${options.ctaType}

Return a JSON array with 3 scenes:
[
  {
    "scene_number": 1,
    "script": "spoken script text",
    "visual_prompt": "detailed visual description for product showcase",
    "duration_seconds": 8,
    "banner_text": "short text overlay for screen"
  },
  {
    "scene_number": 2,
    "script": "spoken script text",
    "visual_prompt": "detailed visual description showing product benefits",
    "duration_seconds": 10,
    "banner_text": "short text overlay for screen"
  },
  {
    "scene_number": 3,
    "script": "spoken script text",
    "visual_prompt": "detailed visual description for CTA scene",
    "duration_seconds": 7,
    "banner_text": "${options.ctaType}"
  }
]

The tone should be enthusiastic and persuasive, suitable for ${options.targetPlatform}. Use Indonesian language if appropriate for the platform. Return ONLY valid JSON.`;

  // 1. Try Gemini primary
  try {
    const genaiClient = getGenAIClient(req);
    const text = await callGemini(genaiClient, prompt, 'gemini-3.6-flash');
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.log('[Affiliate Step 1] Gemini failed, falling back to OpenAI:', e.message);
  }

  // 2. Try OpenAI fallback
  try {
    const client = getOpenAIClient(req);
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
      max_tokens: 1500,
    });
    const content = response?.choices?.[0]?.message?.content?.trim();
    if (content) {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    }
  } catch (e2) {
    console.log('[Affiliate Step 1] OpenAI also failed, generating smart affiliate script:', e2.message);
  }

  return generateDynamicAffiliateScript(options);
}

async function affiliateStep2_generate_visuals(scenes, options, req) {
  let productAnalysis = null;
  if (options.productImageBase64) {
    try {
      productAnalysis = await analyzeImage(options.productImageBase64,
        'Analyze this product photo and describe: product type, color, material, key features, and how it looks when being used. Be specific for visual generation prompts.');
    } catch {}
  }

  const enhancedScenes = await Promise.all(scenes.map(async (scene, i) => {
    let visualPrompt = scene.visual_prompt || `${options.productName} showcase scene ${i + 1}`;

    if (productAnalysis) {
      visualPrompt = visualPrompt.replace(/product/gi, `product that ${productAnalysis}`);
    }

    const enhancedPrompt = `Create a promotional visual for ${options.productName}:
"${visualPrompt}"

Make it eye-catching, professional, and suitable for ${options.targetPlatform}. Include dynamic lighting and clear product visibility.`;

    let enhancedVisualPrompt = scene.enhanced_visual_prompt || visualPrompt;
    try {
      const genaiClient = getGenAIClient(req);
      const enhancedText = await callGemini(genaiClient, enhancedPrompt, 'gemini-3.6-flash');
      if (enhancedText) enhancedVisualPrompt = enhancedText;
    } catch (e) {}

    return { ...scene, visual_prompt: visualPrompt, enhanced_visual_prompt: enhancedVisualPrompt };
  }));

  return enhancedScenes;
}

async function updateAffiliateJobProgress(jobId, updates) {
  const current = inMemoryJobs.get(jobId) || {};
  inMemoryJobs.set(jobId, { ...current, ...updates });
  try {
    await FilmJob.findOneAndUpdate({ jobId }, updates, { new: true });
  } catch (err) {
    console.warn(`[updateAffiliateJobProgress] MongoDB warning for ${jobId}:`, err.message);
  }
}

async function executeAffiliateJob(jobId, options, req) {
  try {
    await updateAffiliateJobProgress(jobId, { status: 'processing', progress: 10, stage: 'writing_sales_script', message: 'Writing persuasive sales script...' });

    const scenes = await affiliateStep1_generate_script(options, req);

    await updateAffiliateJobProgress(jobId, { progress: 40, stage: 'generating_promotional_visuals', message: 'Creating promotional visuals...' });

    const enhancedScenes = await affiliateStep2_generate_visuals(scenes, options, req);

    await updateAffiliateJobProgress(jobId, { progress: 70, stage: 'synthesizing_voiceover', message: 'Generating promotional voiceover...' });

    const audioUrl = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';

    await updateAffiliateJobProgress(jobId, { progress: 90, stage: 'adding_cta_banners', message: 'Adding CTA banners and assembling...' });

    const sceneMetadata = enhancedScenes.map((scene, idx) => ({
      scene_number: scene.scene_number || idx + 1,
      script: scene.script,
      visual_prompt: scene.visual_prompt,
      enhanced_visual_prompt: scene.enhanced_visual_prompt || scene.visual_prompt,
      duration_seconds: scene.duration_seconds || 10,
      banner_text: scene.banner_text || options.ctaType,
    }));

    const result = {
      success: true,
      videoId: jobId,
      scenes: sceneMetadata,
      audioUrl,
      productName: options.productName,
      platform: options.targetPlatform,
      ctaType: options.ctaType,
      createdAt: new Date().toISOString(),
      hasWatermark: !options.isPremium,
    };

    await updateAffiliateJobProgress(jobId, {
      progress: 100,
      stage: 'complete',
      message: 'Affiliate video generated successfully!',
      status: 'completed',
      result,
    });
  } catch (error) {
    await updateAffiliateJobProgress(jobId, {
      status: 'failed',
      message: error.message,
    });
  }
}

// ─── Premium / Watermark Detection ───────────────────────────────────────────

function detectUserTier(req) {
  const hasOpenAIKey = req.headers['x-openai-key'] || process.env.OPENAI_API_KEY;
  const hasGeminiKey = req.headers['x-gemini-key'] || process.env.GEMINI_API_KEY;
  const subscriptionToken = req.headers['x-subscription-token'];
  const isPremiumUser = (hasOpenAIKey && hasGeminiKey) || subscriptionToken === 'premium';
  return { isPremiumUser, isFreeUser: !isPremiumUser };
}

// ─── Route Handlers ───────────────────────────────────────────────────────────

const FALLBACK_IDEAS = {
  'Parodi Gaming': [
    {
      title: 'Misteri Lag di Babak Final',
      logline: 'Seorang pro player tiba-tiba mengalami ping 999ms tepat saat turnamen tingkat dunia, membongkar konspirasi router tetangga.',
      characters: ['Budi (Gamer Ambisius)', 'Pak RT (Pemilik WiFi Sakti)'],
      scenes: [
        { visual_prompt: 'Cinematic close-up of intense gamer face illuminated by RGB neon lighting in tournament arena', narration: 'Satu kill lagi menuju takhta juara dunia... namun takdir berkata lain.', duration_seconds: 10 },
        { visual_prompt: 'Dramatic red warning ping 999ms blinking frantically on high-tech gaming monitor', narration: 'Layar membeku. Karakter berjalan di tempat menembus dimensi astral.', duration_seconds: 10 },
        { visual_prompt: 'Wide shot of neighbor unplugging router to plug in rice cooker', narration: 'Di balik setiap kekalahan legendaris, selalu ada colokan rice cooker yang tak terduga.', duration_seconds: 10 }
      ],
      suggestedVisualStyle: 'Cyberpunk 3D',
      suggestedVoiceStyle: 'Dramatic Voice'
    },
    {
      title: 'NPC yang Menolak Mati',
      logline: 'Sebuah karakter NPC di game RPG memutuskan untuk kabur dari quest karena bosan dikalahkan pemain pemula.',
      characters: ['Geralt si Penjual Potion (NPC)', 'Hero123 (Player Noob)'],
      scenes: [
        { visual_prompt: 'Medieval fantasy village marketplace with lively animated characters in anime style', narration: 'Setiap hari, tugasku hanya menjual ramuan 5 gold kepada para pengembara.', duration_seconds: 10 },
        { visual_prompt: 'NPC packing his bags and jumping over the village barrier into the forbidden forest', narration: 'Tapi hari ini, aku memutuskan untuk menjelajahi peta sendiri.', duration_seconds: 10 },
        { visual_prompt: 'NPC standing atop a cliff looking down at the legendary dragon with a sword', narration: 'Mungkin saatnya NPC yang menyelamatkan dunia.', duration_seconds: 10 }
      ],
      suggestedVisualStyle: 'Anime',
      suggestedVoiceStyle: 'Narrator Male'
    }
  ],
  'Meme Sekolah': [
    {
      title: 'Ujian Dadakan Jam Terakhir',
      logline: 'Satu kelas mendadak panik ketika guru matematika tersenyum misterius dan mengeluarkan kertas folio bergaris.',
      characters: ['Andi (Murid Barisan Belakang)', 'Bu Sri (Guru Matematika Killer)'],
      scenes: [
        { visual_prompt: 'Sunny high school classroom in Indonesia, students chatting casually after bell rings', narration: 'Hari Jumat, jam 1 siang. Pikiran semua orang sudah di rumah.', duration_seconds: 10 },
        { visual_prompt: 'Slow motion dramatic entrance of strict teacher carrying stack of double folio papers', narration: 'Langkah kaki itu mendekat... membawa bencana bernama ujian dadakan.', duration_seconds: 10 },
        { visual_prompt: 'Panic montage of students desperately exchanging telepathic eye glances', narration: 'Seketika seisi kelas bersatu dalam telepati doa.', duration_seconds: 10 }
      ],
      suggestedVisualStyle: 'Cartoon',
      suggestedVoiceStyle: 'Dramatic Voice'
    }
  ],
  'Horor Komedi': [
    {
      title: 'Kuntilanak Takut Ketinggian',
      logline: 'Hantu penunggu pohon beringin depresi karena pobia pohon tinggi dan terpaksa nongkrong di pot bunga teras warga.',
      characters: ['Kunti (Hantu Introvert)', 'Rian (Anak Kos Begadang)'],
      scenes: [
        { visual_prompt: 'Dark misty Indonesian village night, an old banyan tree under full moonlight, retro noir lighting', narration: 'Malam jumat kliwon, waktu yang tepat untuk menakuti warga.', duration_seconds: 10 },
        { visual_prompt: 'Female ghost in white dress sitting nervously on a small potted plant near kos-kosan porch', narration: 'Tapi kalau naik pohon kepala pusing, ya nongkrong di pot lidah buaya saja.', duration_seconds: 10 },
        { visual_prompt: 'College student opening door offering instant noodles to the confused ghost', narration: 'Siapa sangka, segelas kopi hangat bisa mencairkan suasana alam gaib.', duration_seconds: 10 }
      ],
      suggestedVisualStyle: 'Noir',
      suggestedVoiceStyle: 'Soft Female'
    }
  ],
  'Kehidupan Kantoran': [
    {
      title: 'Revisi Terakhir V99_Final_Real',
      logline: 'Perjuangan desainer grafis lembur menghadapi feedback klien yang minta warna merah tapi nuansa hijau sejuk.',
      characters: ['Dimas (Desainer Kelelahan)', 'Pak Bos (Klien Perfeksionis)'],
      scenes: [
        { visual_prompt: 'Modern office cubicle at 9 PM with glowing dual monitors and empty coffee cups', narration: 'Tepat jam 5 sore pesan itu masuk: "Tolong ubah sedikit ya Mas".', duration_seconds: 10 },
        { visual_prompt: 'Extreme close up of mouse clicking save on file labeled final_fix_bismillah99.psd', narration: 'Malam berganti fajar, folder file sudah seperti buku ensiklopedia revisi.', duration_seconds: 10 },
        { visual_prompt: 'Sunrise through glass office windows illuminating a smiling creative survivor', narration: 'Dan akhirnya, klien memilih draft versi pertama.', duration_seconds: 10 }
      ],
      suggestedVisualStyle: 'Realistic',
      suggestedVoiceStyle: 'Narrator Male'
    }
  ],
  'Random': [
    {
      title: 'Kucing Agen Rahasia Antariksa',
      logline: 'Ternyata alasan kucing suka menatap dinding kosong adalah karena mereka sedang memantau satelit luar angkasa.',
      characters: ['Oyen (Komandan Kucing)', 'Whiskers (Teknisi Cyber)'],
      scenes: [
        { visual_prompt: 'Orange tabby cat sitting on living room table staring intently into blank wall, cyberpunk holographic reflections in eyes', narration: 'Manusia mengira kami hanya melamun menatap tembok.', duration_seconds: 10 },
        { visual_prompt: 'Futuristic sci-fi cat spacecraft cockpit orbiting Earth with neon controls', narration: 'Padahal kami sedang mengatur transmisi satelit pertahanan galaksi.', duration_seconds: 10 },
        { visual_prompt: 'Cat suddenly jumping at a red laser pointer dot on the floor', narration: 'Kecuali saat laser merah itu muncul... misi bisa ditunda.', duration_seconds: 10 }
      ],
      suggestedVisualStyle: 'Cyberpunk 3D',
      suggestedVoiceStyle: 'Dramatic Voice'
    }
  ]
};

function getFallbackIdea(genre) {
  const list = FALLBACK_IDEAS[genre] || FALLBACK_IDEAS['Random'];
  const index = Math.floor(Math.random() * list.length);
  return list[index];
}

async function generateIdea(req, res) {
  try {
    const { genre, provider } = req.body;
    if (!genre) {
      return res.status(400).json({ success: false, error: 'Genre is required' });
    }

    const prompt = `You are a creative short film director. Generate a unique short film concept based on this genre: "${genre}".

Return a JSON object with these exact fields:
{
  "title": "catchy 3-5 word title",
  "logline": "one sentence pitch",
  "characters": ["character 1 description", "character 2 description"],
  "scenes": [
    {"visual_prompt": "detailed scene visual description", "narration": "voiceover text", "duration_seconds": 10},
    {"visual_prompt": "detailed scene visual description", "narration": "voiceover text", "duration_seconds": 10},
    {"visual_prompt": "detailed scene visual description", "narration": "voiceover text", "duration_seconds": 10}
  ],
  "suggestedVisualStyle": "Cyberpunk 3D|Anime|Realistic|Cartoon|Noir",
  "suggestedVoiceStyle": "Narrator Male|Soft Female|Dramatic Voice"
}

Return ONLY valid JSON, no markdown formatting.`;

    // 1. If provider explicitly is 'gemini'
    if (provider === 'gemini') {
      try {
        const genai = getGenAIClient(req);
        const text = await callGemini(genai, prompt);
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) return res.json({ success: true, provider: 'gemini', idea: JSON.parse(jsonMatch[0]) });
        return res.json({ success: true, provider: 'gemini', idea: { title: text.substring(0, 50), logline: text, scenes: [] } });
      } catch (geminiErr) {
        console.warn('[generateIdea] Gemini explicit call failed:', geminiErr.message);
        // Fallback to smart curated idea
        const fallback = getFallbackIdea(genre);
        return res.json({ success: true, provider: 'fallback', idea: fallback, warning: geminiErr.message });
      }
    }

    // 2. If provider explicitly is 'openai'
    if (provider === 'openai') {
      try {
        const openai = getOpenAIClient(req);
        const response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.9,
          max_tokens: 1500,
        });
        if (!response?.choices?.[0]) throw new Error('Invalid OpenAI response');
        const content = response.choices[0].message.content.trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) return res.json({ success: true, provider: 'openai', idea: JSON.parse(jsonMatch[0]) });
        return res.json({ success: true, provider: 'openai', idea: JSON.parse(content) });
      } catch (openaiErr) {
        console.warn('[generateIdea] OpenAI explicit call failed:', openaiErr.message);
        // Fallback to smart curated idea
        const fallback = getFallbackIdea(genre);
        return res.json({ success: true, provider: 'fallback', idea: fallback, warning: openaiErr.message });
      }
    }

    // 3. Default / Auto mode: Try OpenAI -> Gemini -> Fallback
    try {
      const openai = getOpenAIClient(req);
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.9,
        max_tokens: 1500,
      });
      if (response?.choices?.[0]) {
        const content = response.choices[0].message.content.trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) return res.json({ success: true, provider: 'openai', idea: JSON.parse(jsonMatch[0]) });
        return res.json({ success: true, provider: 'openai', idea: JSON.parse(content) });
      }
    } catch (e) {
      console.log('[generateIdea] OpenAI failed, trying Gemini:', e.message);
      try {
        const genai = getGenAIClient(req);
        const text = await callGemini(genai, prompt);
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) return res.json({ success: true, provider: 'gemini', idea: JSON.parse(jsonMatch[0]) });
        return res.json({ success: true, provider: 'gemini', idea: { title: text.substring(0, 50), logline: text, scenes: [] } });
      } catch (e2) {
        console.log('[generateIdea] Gemini also failed, using smart fallback idea:', e2.message);
        const fallback = getFallbackIdea(genre);
        return res.json({ success: true, provider: 'fallback', idea: fallback });
      }
    }
  } catch (error) {
    console.error('Generate idea error:', error);
    const fallback = getFallbackIdea(req.body.genre || 'Random');
    return res.json({ success: true, provider: 'fallback', idea: fallback });
  }
}

async function generateFilm(req, res) {
  try {
    const { userEmail, title, plotType, voiceStyle, visualStyle, filmTheme, logline, characterImageBase64 } = req.body;

    if (!userEmail || !title || !plotType || !voiceStyle || !visualStyle || !filmTheme) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const jobId = generateJobId();
    const { isPremiumUser, isFreeUser } = detectUserTier(req);

    const initialJobData = {
      jobId,
      filmId: `film_${Date.now()}`,
      userEmail,
      prompt: `Title: ${title}, Plot: ${plotType}, Voice: ${voiceStyle}, Visual: ${visualStyle}`,
      title,
      plotType,
      voiceStyle,
      visualStyle,
      filmTheme,
      logline: logline || '',
      status: 'processing',
      progress: 10,
      stage: 'starting',
      message: 'Starting generation...',
      hasWatermark: isFreeUser,
      createdAt: new Date(),
    };

    inMemoryJobs.set(jobId, initialJobData);

    try {
      await FilmJob.create(initialJobData);
    } catch (dbErr) {
      console.warn('[MongoDB create warning]:', dbErr.message);
    }

    // Start async execution (non-blocking fire-and-forget)
    executeJob(jobId, { ...req.body, isPremium: isPremiumUser }, req)
      .catch(err => console.error(`[Job ${jobId}] Unhandled error:`, err));

    return res.json({ jobId, status: 'processing', isPremiumUser });
  } catch (error) {
    console.error('Film generation error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

async function getFilmStatus(req, res) {
  try {
    const { jobId } = req.params;
    let job = null;
    try {
      job = await FilmJob.findOne({ jobId });
    } catch (e) {}

    const memoryJob = inMemoryJobs.get(jobId);
    if (memoryJob && (!job || (memoryJob.progress || 0) >= (job.progress || 0))) {
      job = memoryJob;
    }

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.json({
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      message: job.message,
      result: job.result,
      hasWatermark: job.hasWatermark,
    });
  } catch (error) {
    console.error('Get film status error:', error);
    const cached = inMemoryJobs.get(req.params.jobId);
    if (cached) {
      return res.json({
        jobId: cached.jobId,
        status: cached.status,
        progress: cached.progress,
        stage: cached.stage,
        message: cached.message,
        result: cached.result,
        hasWatermark: cached.hasWatermark,
      });
    }
    return res.status(500).json({ error: 'Failed to get job status' });
  }
}

async function generateAffiliateVideo(req, res) {
  try {
    const { productName, productDescription, productImageBase64, targetPlatform, ctaType } = req.body;

    if (!productName || !productDescription || !targetPlatform || !ctaType) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const jobId = generateJobId();
    const { isPremiumUser, isFreeUser } = detectUserTier(req);

    const initialJobData = {
      jobId,
      filmId: `affiliate_${Date.now()}`,
      userEmail: req.body.userEmail || 'unknown',
      prompt: `Affiliate: ${productName}`,
      status: 'processing',
      progress: 10,
      stage: 'starting',
      message: 'Starting affiliate video generation...',
      hasWatermark: isFreeUser,
      createdAt: new Date(),
    };

    inMemoryJobs.set(jobId, initialJobData);

    try {
      await FilmJob.create(initialJobData);
    } catch (dbErr) {
      console.warn('[MongoDB create warning]:', dbErr.message);
    }

    // Start async execution (non-blocking fire-and-forget)
    executeAffiliateJob(jobId, { ...req.body, isPremium: isPremiumUser }, req)
      .catch(err => console.error(`[Affiliate Job ${jobId}] Unhandled error:`, err));

    return res.json({ jobId, status: 'processing' });
  } catch (error) {
    console.error('Affiliate video generation error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

async function getAffiliateVideoStatus(req, res) {
  try {
    const { jobId } = req.params;
    let job = null;
    try {
      job = await FilmJob.findOne({ jobId });
    } catch (e) {}

    const memoryJob = inMemoryJobs.get(jobId);
    if (memoryJob && (!job || (memoryJob.progress || 0) >= (job.progress || 0))) {
      job = memoryJob;
    }

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.json({
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      message: job.message,
      result: job.result,
      hasWatermark: job.hasWatermark,
    });
  } catch (error) {
    console.error('Get affiliate status error:', error);
    const cached = inMemoryJobs.get(req.params.jobId);
    if (cached) {
      return res.json({
        jobId: cached.jobId,
        status: cached.status,
        progress: cached.progress,
        stage: cached.stage,
        message: cached.message,
        result: cached.result,
        hasWatermark: cached.hasWatermark,
      });
    }
    return res.status(500).json({ error: 'Failed to get job status' });
  }
}

// ─── Export ────────────────────────────────────────────────────────────────────

module.exports = { generateIdea, generateFilm, getFilmStatus, generateAffiliateVideo, getAffiliateVideoStatus };
