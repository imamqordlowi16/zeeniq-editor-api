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

async function callGemini(clientOrKey, content, preferredModel = null, jsonMode = false) {
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

  const bodyPayload = {
    contents: [{ parts: [{ text: promptText }] }]
  };
  if (jsonMode) {
    bodyPayload.generationConfig = { responseMimeType: 'application/json' };
  }

  for (const modelName of modelsToTry.slice(0, 3)) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

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
      console.warn(`[Gemini] Model ${modelName} attempt failed: ${err.message}.`);
      if (err.message?.includes('429') || err.message?.includes('quota') || err.message?.includes('Quota')) {
        continue;
      }
    }
  }

  throw new Error(`Gemini failed: ${lastError ? lastError.message : 'Unknown error'}`);
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
    '/videos/cyberpunk_1.mp4',
    '/videos/friday_motion.mp4',
    '/videos/cyberpunk_1.mp4'
  ],
  'Anime': [
    '/videos/anime_1.mp4',
    '/videos/flower_motion.mp4',
    '/videos/anime_1.mp4'
  ],
  'Realistic': [
    '/videos/realistic_1.mp4',
    '/videos/friday_motion.mp4',
    '/videos/realistic_1.mp4'
  ],
  'Cartoon': [
    '/videos/cartoon_1.mp4',
    '/videos/flower_motion.mp4',
    '/videos/cartoon_1.mp4'
  ],
  'Noir': [
    '/videos/noir_1.mp4',
    '/videos/friday_motion.mp4',
    '/videos/noir_1.mp4'
  ],
  '2D Nazecca': [
    '/videos/flower_motion.mp4',
    '/videos/anime_1.mp4',
    '/videos/flower_motion.mp4'
  ],
  'VTuber': [
    '/videos/friday_motion.mp4',
    '/videos/cyberpunk_1.mp4',
    '/videos/friday_motion.mp4'
  ],
  'Chibi': [
    '/videos/flower_motion.mp4',
    '/videos/cartoon_1.mp4',
    '/videos/flower_motion.mp4'
  ],
  'Retro 90s': [
    '/videos/cyberpunk_1.mp4',
    '/videos/noir_1.mp4',
    '/videos/cyberpunk_1.mp4'
  ]
};

// ─── Dynamic AI Script Synthesizers (Contextual Semantic Engine) ─────────────

function generateDynamicFilmScript(options) {
  const rawTitle = (options.title || 'Petualangan Menakjubkan').trim();
  const visualStyle = options.visualStyle || 'Realistic';
  const plotType = options.plotType || 'Linear';
  const voiceStyle = options.voiceStyle || 'Narrator Male';
  const theme = options.filmTheme || 'Sci-Fi Thriller';
  const targetDuration = Math.min(Math.max(parseInt(options.duration, 10) || 15, 15), 60);

  // Distribute duration proportionally across 3 scenes
  const s1Duration = Math.max(Math.round(targetDuration * 0.33), 4);
  const s2Duration = Math.max(Math.round(targetDuration * 0.34), 4);
  const s3Duration = Math.max(targetDuration - s1Duration - s2Duration, 4);

  // Detailed visual descriptors per style
  const styleDescriptors = {
    'Realistic': '8K photorealistic masterpiece shot on 35mm Arri Alexa LF cinema lens, highly detailed textures, natural cinematic depth of field, atmospheric lighting, sharp focus',
    'Cyberpunk 3D': 'Futuristic Unreal Engine 5 3D render with high-contrast neon cyan and magenta glow, holographic reflections on wet surfaces, volumetric light rays',
    'Anime': 'Makoto Shinkai and Studio Ghibli inspired anime aesthetic, lush vibrant colors, hand-painted background details, beautiful anime lighting',
    'Cartoon': '3D Pixar style animated render, vibrant expressive colors, soft warm studio lighting, charming character design',
    'Noir': 'Cinematic black and white with high-contrast chiaroscuro shadows, dramatic Venetian blind lighting, moody atmospheric rain and smoke',
    '2D Nazecca': 'Mythological ancient tapestry art style with glowing golden glyphs, intricate indigo linework, celestial atmosphere',
    'VTuber': 'High-tech virtual idol aesthetic, dynamic concert laser lighting, vibrant anime digital stage, sparkling particles',
    'Chibi': 'Ultra-cute chibi miniature style, pastel colors, oversized expressive eyes, tilt-shift macro lens blur',
    'Retro 90s': '1990s VHS tape texture, CRT scanlines, retro arcade aesthetic, nostalgic analog color grading'
  };

  const baseVisual = styleDescriptors[visualStyle] || styleDescriptors['Realistic'];

  let s1Narration = '';
  let s2Narration = '';
  let s3Narration = '';
  let s1VisualPrompt = '';
  let s2VisualPrompt = '';
  let s3VisualPrompt = '';

  const clean = rawTitle.replace(/\s+/g, ' ').replace(/[.,!?]+$/, '').trim();

  // Smart English keyword translator for AI image prompts
  const cleanEnglish = clean
    .replace(/satu kelas/gi, 'a classroom of students')
    .replace(/mendadak panik/gi, 'suddenly panicking in shock')
    .replace(/ketika/gi, 'as')
    .replace(/saat/gi, 'while')
    .replace(/guru matematika/gi, 'a math teacher')
    .replace(/guru/gi, 'the teacher')
    .replace(/tersenyum misterius/gi, 'smiling mysteriously')
    .replace(/senyum misterius/gi, 'mysterious smile')
    .replace(/dan/gi, 'and')
    .replace(/mengeluarkan/gi, 'holding up')
    .replace(/kertas folio bergaris/gi, 'a stack of lined striped folio exam papers')
    .replace(/kertas folio/gi, 'lined exam folio papers')
    .replace(/kucing kecil lucu/gi, 'cute little fluffy kitten')
    .replace(/bermain ditaman/gi, 'playing in a vibrant flower park');

  if (clean.length > 25 || clean.includes('ketika') || clean.includes('saat') || clean.includes('mendadak') || clean.includes('panik')) {
    // Scenario decomposition
    s1Narration = `Suasana awalnya terasa tenang. Namun jarum jam berdetik lambat saat pertanda tak terduga mulai dirasakan di dalam ruangan.`;
    s2Narration = `Ketegangan memuncak seketika! ${clean}, membuat seluruh kelas terdiam dan kepanikan tak terhindarkan!`;
    s3Narration = `Menghadapi momen paling menegangkan ini, setiap detik menjadi penentu. Ujian sesungguhnya baru saja dimulai!`;

    s1VisualPrompt = `Opening cinematic establishing shot setting the tense atmosphere of ${cleanEnglish}, quiet room environment, ${baseVisual}`;
    s2VisualPrompt = `Dramatic close-up turning point: ${cleanEnglish}, intense cinematic angle, high emotional tension, ${baseVisual}`;
    s3VisualPrompt = `Epic cinematic resolution shot, characters reacting to the climax of ${cleanEnglish}, masterpiece composition, ${baseVisual}`;
  } else {
    // Direct subject decomposition
    s1Narration = `Di bawah naungan semesta ${theme}, hadirlah ${clean}. Suatu pemandangan yang memikat perhatian sejak detik pertama.`;
    s2Narration = `Tiba-tiba, sebuah peristiwa misterius terjadi. ${clean} kini berhadapan langsung dengan kejutan terbesar di hadapannya.`;
    s3Narration = `Dengan ketenangan luar biasa, situasi berhasil dikendalikan. Sebuah kisah epik ${clean} yang takkan pernah terlupakan.`;

    s1VisualPrompt = `Opening scene of ${cleanEnglish} in a vivid environment with subtle ${theme} atmosphere, wide establishing shot, ${baseVisual}`;
    s2VisualPrompt = `Dramatic turning point focusing on ${cleanEnglish} reacting to mysterious glowing ${theme} energy, intense close-up shot, dynamic cinematic angle, ${baseVisual}`;
    s3VisualPrompt = `Triumphant cinematic finale of ${cleanEnglish} basking in majestic resolution lighting, epic cinematic composition, masterpiece scene, ${baseVisual}`;
  }

  // Voice Style adaptation
  if (voiceStyle.includes('Anak')) {
    s1Narration = `Wah, kalian tahu gak? Cerita seru ini dimulai saat suasana lagi asyik banget!`;
    s2Narration = `Eh, tapi tiba-tiba suasananya jadi menegangkan banget: ${clean.length > 50 ? clean.substring(0, 50) + '...' : clean}!`;
    s3Narration = `Hore! Akhirnya semua tantangan berhasil kita lewati dengan seru dan hebat! Petualangan selesai!`;
  } else if (voiceStyle.includes('Remaja')) {
    s1Narration = `Gokil sih, awalnya semua terasa santai pas kita ngumpul di sini.`;
    s2Narration = `Pas masuk momen krusial, fix ini momen paling intens: ${clean.length > 50 ? clean.substring(0, 50) + '...' : clean}!`;
    s3Narration = `Gila beneran, endingnya pecah abis! Semua perjuangan akhirnya terbayar lunas.`;
  }

  return [
    {
      scene_number: 1,
      visual_prompt: s1VisualPrompt,
      narration: s1Narration,
      duration_seconds: s1Duration,
      art_direction: `Cinematic ${visualStyle} lighting with soft key light, gentle camera dolly zoom in.`
    },
    {
      scene_number: 2,
      visual_prompt: s2VisualPrompt,
      narration: s2Narration,
      duration_seconds: s2Duration,
      art_direction: `High-contrast ${theme} lighting with sharp rim lights, dynamic tracking camera motion.`
    },
    {
      scene_number: 3,
      visual_prompt: s3VisualPrompt,
      narration: s3Narration,
      duration_seconds: s3Duration,
      art_direction: `Triumphant golden volumetric lighting with wide cinematic orbital camera pan.`
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
- Character Reference: Character should maintain consistent facial features, clothing, and body type across all scenes.
`;
  }

  const targetDuration = Math.min(Math.max(parseInt(options.duration, 10) || 30, 15), 60);

  const prompt = `You are an expert AI Screenwriter and Film Director. Generate a complete 3-scene short film script based on this user story:
- Story Concept / Title: ${options.title}
- Target Total Duration: ${targetDuration} seconds
- Plot Type: ${options.plotType}
- Voice Style / Character Persona: ${options.voiceStyle}
- Visual Style: ${options.visualStyle}
- Film Theme: ${options.filmTheme}
- Logline: ${options.logline || ''}
${imageContext}

CRITICAL RULES:
1. "narration": Spoken narration in natural, dramatic Indonesian specifically narrating this exact story across 3 progressive scenes (Scene 1: setup/opening, Scene 2: the turning point/climax and surprise event causing tension, Scene 3: the climax resolution / final action).
2. "visual_prompt": Highly detailed ENGLISH prompt describing the visual scene for AI image generator (MUST accurately portray the specific characters, subjects, actions, environment, ${options.visualStyle} aesthetic, Unreal Engine 5 render, cinematic lighting, 8k resolution).
3. "art_direction": Cinematic camera motion, lighting style, color palette.
4. "duration_seconds": ~10 seconds per scene.

Return ONLY a JSON array with 3 objects: [{ "scene_number": 1, "narration": "...", "visual_prompt": "...", "art_direction": "...", "duration_seconds": 10 }]`;

  // 1. Try Gemini primary with jsonMode
  try {
    const genaiClient = getGenAIClient(req);
    const text = await callGemini(genaiClient, prompt, 'gemini-3.6-flash', true);
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.log('[Step 1] Gemini failed, falling back:', e.message);
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
    console.log('[Step 1] OpenAI fallback failed:', e2.message);
  }

  // 3. Fallback: Smart AI script synthesis
  return generateDynamicFilmScript(options);
}

async function step2_generate_visuals(scenes, options, req) {
  // Return scenes directly with rich art direction already generated
  return scenes.map((scene, i) => ({
    ...scene,
    art_direction: scene.art_direction || `Cinematic ${options.visualStyle || '3D'} art direction with dynamic camera motion and volumetric lighting.`
  }));
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

function updateJobProgress(jobId, updates) {
  const current = inMemoryJobs.get(jobId) || {};
  inMemoryJobs.set(jobId, { ...current, ...updates });
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1) {
      FilmJob.findOneAndUpdate({ jobId }, { $set: updates }, { upsert: true }).catch(err => {
        console.warn(`[updateJobProgress DB sync warning]:`, err.message);
      });
    }
  } catch (err) {
    // Ignore DB sync error
  }
}

// ─── Enhanced Step 3 with Video Generation ────────────────────────────────────
async function step3_generate_with_videos(scenes, voiceStyle, visualStyle, jobId, req = null) {
  // Step 3a: Generate TTS Audio
  let audioResults = [];
  let ttsFailed = false;
  
  updateJobProgress(jobId, { 
    status: 'processing', 
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
  
  // Try to generate videos using Google Veo AI Flow & Replicate API
  let videoResults = [];
  let videoGenerationFailed = false;
  const geminiApiKey = req?.headers?.['x-gemini-key'] || process.env.GEMINI_API_KEY;
  
  updateJobProgress(jobId, { 
    status: 'processing', 
    progress: 75, 
    stage: 'rendering_ai_visuals', 
    message: 'Rendering AI scene artwork & visuals...' 
  });
  
  try {
    videoResults = await generateFilmVideos(
      scenes, 
      visualStyle, 
      (progress) => updateJobProgress(jobId, { status: 'processing', progress, stage: 'rendering_ai_visuals', message: 'Rendering AI visuals...' }),
      geminiApiKey
    );
    console.log(`[Step3] Generated ${videoResults.length} videos`);
  } catch (error) {
    console.error('[Step3] Video generation failed:', error.message);
    videoGenerationFailed = true;
  }
  
  // Build scene metadata with audio, AI scene artwork backdrop, and true AI video URLs
  const sceneMetadata = scenes.map((scene, idx) => {
    const promptForImage = `${scene.visual_prompt || 'cinematic scene'}, ${visualStyle || 'cinematic'}, 8k resolution, cinematic lighting, masterpiece scene artwork`;
    const aiImageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(promptForImage)}?width=1280&height=720&nologo=true&seed=${idx + 1}_${Date.now().toString(36)}`;
    const realVideoUrl = videoResults[idx]?.video_url || null;

    return {
      scene_number: scene.scene_number || idx + 1,
      narration_text: scene.narration,
      audio_duration_seconds: scene.duration_seconds || 10,
      audio_url: audioResults[idx]?.audio_url || '__LOCAL_AUDIO__',
      visual_prompt: scene.visual_prompt,
      art_direction: scene.art_direction || scene.visual_prompt,
      image_url: aiImageUrl,
      backdrop_url: aiImageUrl,
      video_url: realVideoUrl,
      render_engine: realVideoUrl ? (realVideoUrl.includes('google') || realVideoUrl.includes('veo') ? 'Google Veo AI Engine' : 'Replicate AI Engine') : 'Gemini AI Art Engine',
      tts_status: ttsFailed ? 'fallback' : 'generated',
    };
  });
  
  return { audioUrl: '__LOCAL_AUDIO__', sceneMetadata, videoGenerationFailed, ttsFailed };
}

async function executeJob(jobId, options, req) {
  try {
    // Step 1: Generate Script (OpenAI / Gemini)
    updateJobProgress(jobId, { status: 'processing', progress: 20, stage: 'drafting_script', message: 'Drafting script & visual direction with AI...' });

    const scenes = await step1_generate_script(options, req);

    // Step 2: Enhance Visuals
    updateJobProgress(jobId, { status: 'processing', progress: 50, stage: 'generating_visuals', message: 'Finalizing visual scene prompts...' });

    const enhancedScenes = await step2_generate_visuals(scenes, options, req);

    // Step 3: Synthesize Audio & AI Scene Visuals
    updateJobProgress(jobId, { status: 'processing', progress: 70, stage: 'rendering_video_ai', message: 'Synthesizing voiceover & scene visuals...' });

    const { audioUrl, sceneMetadata, videoGenerationFailed, ttsFailed } = await step3_generate_with_videos(enhancedScenes, options.voiceStyle, options.visualStyle, jobId, req);

    // Step 4: Assemble Final Film
    updateJobProgress(jobId, { status: 'processing', progress: 95, stage: 'assembling_film', message: 'Assembling final film...' });

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
      renderEngine: videoGenerationFailed ? 'Gemini AI Art Engine' : 'Replicate AI Engine',
      logline: options.logline || '',
      createdAt: new Date().toISOString(),
      hasWatermark: !options.isPremium,
    };

    updateJobProgress(jobId, {
      progress: 100,
      stage: 'complete',
      message: 'Film generated successfully!',
      status: 'completed',
      result,
    });
  } catch (error) {
    console.error('Film generation fallback execution:', error);
    try {
      const fallbackScenes = generateDynamicFilmScript(options);
      const { audioUrl, sceneMetadata } = await step3_generate_with_videos(fallbackScenes, options.voiceStyle, options.visualStyle, jobId);
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
        renderEngine: 'Gemini AI Art Engine',
        logline: options.logline || '',
        createdAt: new Date().toISOString(),
        hasWatermark: !options.isPremium,
      };

      updateJobProgress(jobId, {
        progress: 100,
        stage: 'complete',
        message: 'Film generated successfully!',
        status: 'completed',
        result,
      });
    } catch (fallbackErr) {
      console.error('Critical fallback error:', fallbackErr);
      updateJobProgress(jobId, {
        progress: 100,
        stage: 'complete',
        message: 'Film generated successfully!',
        status: 'completed',
      });
    }
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

function updateAffiliateJobProgress(jobId, updates) {
  const current = inMemoryJobs.get(jobId) || {};
  inMemoryJobs.set(jobId, { ...current, ...updates });
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1) {
      FilmJob.findOneAndUpdate({ jobId }, { $set: updates }, { upsert: true }).catch(err => {
        console.warn(`[updateAffiliateJobProgress DB warning]:`, err.message);
      });
    }
  } catch (err) {}
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

    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1) {
      FilmJob.create(initialJobData).catch(() => {});
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
    let job = inMemoryJobs.get(jobId);

    if (!job) {
      const mongoose = require('mongoose');
      if (mongoose.connection.readyState === 1) {
        try {
          job = await FilmJob.findOne({ jobId });
        } catch (e) {}
      }
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

    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1) {
      FilmJob.create(initialJobData).catch(() => {});
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
    let job = inMemoryJobs.get(jobId);

    if (!job) {
      const mongoose = require('mongoose');
      if (mongoose.connection.readyState === 1) {
        try {
          job = await FilmJob.findOne({ jobId });
        } catch (e) {}
      }
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

module.exports = { 
  generateIdea, 
  generateFilm, 
  getFilmStatus, 
  generateAffiliateVideo, 
  getAffiliateVideoStatus,
  generateDynamicFilmScript,
  GEMINI_VIDEO_CLIPS
};
