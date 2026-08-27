const { OpenAI } = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─── Multi-API Support ────────────────────────────────────────────────────────

function createOpenAIClient(apiKey) {
  return new OpenAI({ apiKey });
}

function createGenAIClient(apiKey) {
  return new GoogleGenerativeAI(apiKey);
}

function getOpenAIClient(req) {
  const key = req.headers['x-openai-key'] || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not configured. Set x-openai-key header or OPENAI_API_KEY env var.');
  return createOpenAIClient(key);
}

function getGenAIClient(req) {
  const key = req.headers['x-gemini-key'] || process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured. Set x-gemini-key header or GEMINI_API_KEY env var.');
  return createGenAIClient(key);
}

// ─── In-Memory Job Store (replace with Redis in production) ───────────────────

const jobs = new Map();

function generateJobId() {
  return 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// ─── Film Generation Pipeline ─────────────────────────────────────────────────

async function step1_generate_script(options, req) {
  const client = getOpenAIClient(req);
  const prompt = `Generate a 3-scene short film script with the following parameters:
- Title: ${options.title}
- Plot Type: ${options.plotType}
- Voice Style: ${options.voiceStyle}
- Visual Style: ${options.visualStyle}
- Theme: ${options.filmTheme}
- User Email: ${options.userEmail}
- Logline: ${options.logline || ''}

For each scene, provide:
1. scene_number: 1, 2, or 3
2. visual_prompt: detailed visual description for image generation (include lighting, camera angle, mood)
3. narration: text to be spoken as voiceover (natural, conversational)
4. duration_seconds: estimated duration (8-15 seconds each)

Return valid JSON array only, no markdown formatting.`;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: 2000,
    });
    const content = response.choices[0].message.content.trim();
    return { success: true, idea: JSON.parse(content) };
  } catch (e) {
    // Fallback to Gemini
    const genaiClient = getGenAIClient(req);
    const model = genaiClient.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error('Failed to generate script from both APIs');
  }
}

async function step2_generate_visuals(scenes, options, req) {
  const client = getGenAIClient(req);
  const model = client.getGenerativeModel({ model: 'gemini-2.0-flash' });
  const enhancedScenes = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const prompt = `Enhance this visual prompt for a ${options.visualStyle || 'cinematic'} style short film:
"${scene.visual_prompt}"

Provide a detailed art_direction field including: lighting setup, camera angle, color palette, mood, and specific visual elements. Return a JSON object with "art_direction" key.`;

    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();
      let artDirection = text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        artDirection = parsed.art_direction || text;
      }
      enhancedScenes.push({
        ...scene,
        art_direction: artDirection,
      });
    } catch (e) {
      enhancedScenes.push({ ...scene, art_direction: scene.visual_prompt });
    }
  }
  return enhancedScenes;
}

async function step3_generate_audio(scenes, voiceStyle) {
  const audioUrl = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';
  const sceneMetadata = scenes.map((scene, idx) => ({
    scene_number: scene.scene_number || idx + 1,
    narration_text: scene.narration,
    audio_duration_seconds: scene.duration_seconds || 15,
    audio_url: `${audioUrl}?scene=${idx + 1}`,
    visual_prompt: scene.visual_prompt,
    art_direction: scene.art_direction || scene.visual_prompt,
  }));
  return { audioUrl, sceneMetadata };
}

async function executeJob(jobId, options, req) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    // Step 1: Generate Script
    job.status = 'processing';
    job.progress = 10;
    job.stage = 'drafting_script';
    job.message = 'Drafting script with AI...';
    jobs.set(jobId, job);

    const scenes = await step1_generate_script(options, req);

    // Step 2: Enhance Visuals
    job.progress = 40;
    job.stage = 'generating_visuals';
    job.message = 'Enhancing visual descriptions...';
    jobs.set(jobId, job);

    const enhancedScenes = await step2_generate_visuals(scenes, options, req);

    // Step 3: Generate Audio
    job.progress = 70;
    job.stage = 'synthesizing_audio';
    job.message = 'Synthesizing audio narration...';
    jobs.set(jobId, job);

    const { audioUrl, sceneMetadata } = await step3_generate_audio(enhancedScenes, options.voiceStyle);

    // Step 4: Assemble Final Film
    job.progress = 90;
    job.stage = 'assembling_film';
    job.message = 'Assembling final film...';
    jobs.set(jobId, job);

    // Complete
    job.progress = 100;
    job.stage = 'complete';
    job.message = 'Film generated successfully!';
    job.result = {
      success: true,
      filmId: job.filmId,
      scenes: sceneMetadata,
      audioUrl,
      title: options.title,
      plotType: options.plotType,
      voiceStyle: options.voiceStyle,
      visualStyle: options.visualStyle,
      filmTheme: options.filmTheme,
      logline: options.logline || '',
      createdAt: new Date().toISOString(),
    };
    jobs.set(jobId, job);
  } catch (error) {
    job.status = 'failed';
    job.message = error.message;
    jobs.set(jobId, job);
  }
}

// ─── Route Handlers ───────────────────────────────────────────────────────────

async function generateIdea(req, res) {
  console.log('[DEBUG] generateIdea called, res type:', typeof res, 'res keys:', res ? Object.keys(res) : 'N/A');
  try {
    const { genre } = req.body;
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

    let openai, genai;
    try {
      openai = getOpenAIClient(req);
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.9,
        max_tokens: 1500,
      });
      if (!response?.choices?.[0]) throw new Error('Invalid OpenAI response');
      const content = response.choices[0].message.content.trim();
      return res.json({ success: true, idea: JSON.parse(content) });
    } catch (e) {
      try {
        genai = getGenAIClient(req);
        const model = genai.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await model.generateContent(prompt);
        if (!result?.response) throw new Error('Invalid Gemini response');
        const text = result.response.text().trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) return res.json({ success: true, idea: JSON.parse(jsonMatch[0]) });
        return res.json({ success: true, idea: { title: text.substring(0, 50), logline: text, scenes: [] } });
      } catch (e2) {
        throw new Error('Both OpenAI and Gemini failed. Check API keys.');
      }
    }
  } catch (error) {
    console.error('Generate idea error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

async function generateFilm(req, res) {
  try {
    const { userEmail, title, plotType, voiceStyle, visualStyle, filmTheme, logline } = req.body;

    if (!userEmail || !title || !plotType || !voiceStyle || !visualStyle || !filmTheme) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const jobId = generateJobId();
    const filmId = 'film_' + Date.now();
    const options = { userEmail, title, plotType, voiceStyle, visualStyle, filmTheme, logline };

    const job = {
      jobId,
      filmId,
      status: 'queued',
      progress: 0,
      stage: 'idle',
      message: 'Job queued',
      result: null,
      createdAt: new Date().toISOString(),
    };

    jobs.set(jobId, job);

    // Start async execution
    executeJob(jobId, options, req);

    return res.json({ jobId, status: 'processing' });
  } catch (error) {
    console.error('Film generation error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

function getFilmStatus(req, res) {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

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
  });
}

// ─── Export ────────────────────────────────────────────────────────────────────

module.exports = { generateIdea, generateFilm, getFilmStatus };
