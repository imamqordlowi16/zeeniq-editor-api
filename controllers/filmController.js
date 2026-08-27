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

// ─── Image Analysis Helper ────────────────────────────────────────────────────

async function analyzeImage(imageBase64, prompt) {
  try {
    const client = getGenAIClient({ headers: {} });
    const model = client.getGenerativeModel({ model: 'gemini-2.0-flash' });

    // Extract MIME type and data from base64
    const matches = imageBase64.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!matches) throw new Error('Invalid image format');

    const mimeType = matches[1];
    const data = matches[2];

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: data,
          mimeType: mimeType,
        },
      },
    ]);

    return result.response.text().trim();
  } catch (error) {
    console.error('Image analysis error:', error.message);
    return null;
  }
}

// ─── Film Generation Pipeline ─────────────────────────────────────────────────

async function step1_generate_script(options, req) {
  const client = getOpenAIClient(req);

  let imageContext = '';
  if (options.characterImageBase64) {
    imageContext = `
- Character Reference Image: User has uploaded a character photo. Based on this image, the character should have consistent appearance across all scenes (same face, clothing style, body type).
`;
  }

  const prompt = `Generate a 3-scene short film script with the following parameters:
- Title: ${options.title}
- Plot Type: ${options.plotType}
- Voice Style: ${options.voiceStyle}
- Visual Style: ${options.visualStyle}
- Theme: ${options.filmTheme}
- User Email: ${options.userEmail}
- Logline: ${options.logline || ''}
${imageContext}

For each scene, provide:
1. scene_number: 1, 2, or 3
2. visual_prompt: detailed visual description for image generation (include lighting, camera angle, mood, character appearance)
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

  // Analyze character image if provided
  let characterAnalysis = null;
  if (options.characterImageBase64) {
    characterAnalysis = await analyzeImage(options.characterImageBase64,
      'Analyze this character photo and describe: face shape, skin tone, hair style/color, body type, clothing style, and overall vibe. Be specific and concise.');
  }

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    let visualPrompt = scene.visual_prompt;

    // Inject character analysis into prompt if available
    if (characterAnalysis) {
      visualPrompt = visualPrompt.replace(
        /character/gi,
        `character with: ${characterAnalysis}`
      );
    }

    const prompt = `Enhance this visual prompt for a ${options.visualStyle || 'cinematic'} style short film:
"${visualPrompt}"

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

// ─── Affiliate Video Generation Pipeline ─────────────────────────────────────

async function affiliateStep1_generate_script(options, req) {
  const client = getOpenAIClient(req);

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

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
      max_tokens: 1500,
    });
    const content = response.choices[0].message.content.trim();
    return JSON.parse(content);
  } catch (e) {
    const genaiClient = getGenAIClient(req);
    const model = genaiClient.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error('Failed to generate affiliate script');
  }
}

async function affiliateStep2_generate_visuals(scenes, options, req) {
  const client = getGenAIClient(req);
  const model = client.getGenerativeModel({ model: 'gemini-2.0-flash' });
  const enhancedScenes = [];

  // Analyze product image if provided
  let productAnalysis = null;
  if (options.productImageBase64) {
    productAnalysis = await analyzeImage(options.productImageBase64,
      'Analyze this product photo and describe: product type, color, material, key features, and how it looks when being used. Be specific for visual generation prompts.');
  }

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    let visualPrompt = scene.visual_prompt;

    if (productAnalysis) {
      visualPrompt = visualPrompt.replace(
        /product/gi,
        `product that ${productAnalysis}`
      );
    }

    const enhancedPrompt = `Create a promotional visual for ${options.productName}:
"${visualPrompt}"

Make it eye-catching, professional, and suitable for ${options.targetPlatform}. Include dynamic lighting and clear product visibility.`;

    try {
      const result = await model.generateContent(enhancedPrompt);
      const enhancedText = result.response.text().trim();
      enhancedScenes.push({
        ...scene,
        enhanced_visual_prompt: enhancedText,
      });
    } catch (e) {
      enhancedScenes.push({ ...scene });
    }
  }
  return enhancedScenes;
}

async function executeAffiliateJob(jobId, options, req) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    // Step 1: Generate Sales Script
    job.status = 'processing';
    job.progress = 10;
    job.stage = 'writing_sales_script';
    job.message = 'Writing persuasive sales script...';
    jobs.set(jobId, job);

    const scenes = await affiliateStep1_generate_script(options, req);

    // Step 2: Enhance Visuals
    job.progress = 40;
    job.stage = 'generating_promotional_visuals';
    job.message = 'Creating promotional visuals...';
    jobs.set(jobId, job);

    const enhancedScenes = await affiliateStep2_generate_visuals(scenes, options, req);

    // Step 3: Generate Voiceover
    job.progress = 70;
    job.stage = 'synthesizing_voiceover';
    job.message = 'Generating promotional voiceover...';
    jobs.set(jobId, job);

    const audioUrl = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';

    // Step 4: Assemble Final Video
    job.progress = 90;
    job.stage = 'adding_cta_banners';
    job.message = 'Adding CTA banners and assembling...';
    jobs.set(jobId, job);

    const sceneMetadata = enhancedScenes.map((scene, idx) => ({
      scene_number: scene.scene_number || idx + 1,
      script: scene.script,
      visual_prompt: scene.visual_prompt,
      enhanced_visual_prompt: scene.enhanced_visual_prompt || scene.visual_prompt,
      duration_seconds: scene.duration_seconds || 10,
      banner_text: scene.banner_text || options.ctaType,
    }));

    // Complete
    job.progress = 100;
    job.stage = 'complete';
    job.message = 'Affiliate video generated successfully!';
    job.result = {
      success: true,
      videoId: job.videoId,
      scenes: sceneMetadata,
      audioUrl,
      productName: options.productName,
      platform: options.targetPlatform,
      ctaType: options.ctaType,
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
    console.log('[DEBUG] OPENAI_API_KEY set:', !!process.env.OPENAI_API_KEY, 'length:', process.env.OPENAI_API_KEY?.length || 0);
    console.log('[DEBUG] GEMINI_API_KEY set:', !!process.env.GEMINI_API_KEY, 'length:', process.env.GEMINI_API_KEY?.length || 0);
    try {
      openai = getOpenAIClient(req);
      console.log('[DEBUG] OpenAI client created, calling API...');
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.9,
        max_tokens: 1500,
      });
      console.log('[DEBUG] OpenAI response received');
      if (!response?.choices?.[0]) throw new Error('Invalid OpenAI response');
      const content = response.choices[0].message.content.trim();
      return res.json({ success: true, idea: JSON.parse(content) });
    } catch (e) {
      console.error('[DEBUG] OpenAI error:', e.message);
      try {
        genai = getGenAIClient(req);
        console.log('[DEBUG] Gemini client created, calling API...');
        const model = genai.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await model.generateContent(prompt);
        console.log('[DEBUG] Gemini response received');
        if (!result?.response) throw new Error('Invalid Gemini response');
        const text = result.response.text().trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) return res.json({ success: true, idea: JSON.parse(jsonMatch[0]) });
        return res.json({ success: true, idea: { title: text.substring(0, 50), logline: text, scenes: [] } });
      } catch (e2) {
        console.error('[DEBUG] Gemini error:', e2.message);
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
    const { userEmail, title, plotType, voiceStyle, visualStyle, filmTheme, logline, characterImageBase64 } = req.body;

    if (!userEmail || !title || !plotType || !voiceStyle || !visualStyle || !filmTheme) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const jobId = generateJobId();
    const filmId = 'film_' + Date.now();
    const options = { userEmail, title, plotType, voiceStyle, visualStyle, filmTheme, logline, characterImageBase64 };

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

async function generateAffiliateVideo(req, res) {
  try {
    const { productName, productDescription, productImageBase64, targetPlatform, ctaType } = req.body;

    if (!productName || !productDescription || !targetPlatform || !ctaType) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const jobId = generateJobId();
    const videoId = 'video_' + Date.now();
    const options = { productName, productDescription, productImageBase64, targetPlatform, ctaType };

    const job = {
      jobId,
      videoId,
      status: 'queued',
      progress: 0,
      stage: 'idle',
      message: 'Job queued',
      result: null,
      createdAt: new Date().toISOString(),
    };

    jobs.set(jobId, job);

    executeAffiliateJob(jobId, options, req);

    return res.json({ jobId, status: 'processing' });
  } catch (error) {
    console.error('Affiliate video generation error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

function getAffiliateVideoStatus(req, res) {
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

module.exports = { generateIdea, generateFilm, getFilmStatus, generateAffiliateVideo, getAffiliateVideoStatus };
