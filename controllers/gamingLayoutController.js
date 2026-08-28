// ─── Gaming Layout Controller — Stream Clip Creator ──────────────────────────

const jobs = new Map();

function generateJobId() {
  return 'gc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

/**
 * Validate user tier via BYOK headers (same logic as filmController)
 */
function detectUserTier(req) {
  const hasOpenAIKey = req.headers['x-openai-key'] || process.env.OPENAI_API_KEY;
  const hasGeminiKey = req.headers['x-gemini-key'] || process.env.GEMINI_API_KEY;
  const subscriptionToken = req.headers['x-subscription-token'];
  const isPremiumUser = (hasOpenAIKey && hasGeminiKey) || subscriptionToken === 'premium';
  return { isPremiumUser, isFreeUser: !isPremiumUser };
}

// ─── Preset configurations for bottom frame styles ─────────────────────────────

const BOTTOM_FRAME_PRESETS = [
  'Naruto Hokage Temple',
  'Cyberpunk City',
  'Minecraft Parkour Loop',
  'Satisfying Sand',
  'Anime Rain City',
  'Retro VHS Gaming',
];

// ─���─ Generate Stream Clip Job ──────────────────────────────────────────────────

async function generateStreamClip(req, res) {
  try {
    const {
      facecamUri,
      gameplayUri,
      streamerName,
      socialHandles,
      bottomFramePreset,
    } = req.body;

    if (!facecamUri || !gameplayUri || !streamerName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: facecamUri, gameplayUri, streamerName',
      });
    }

    if (!BOTTOM_FRAME_PRESETS.includes(bottomFramePreset)) {
      return res.status(400).json({
        success: false,
        error: `Invalid bottomFramePreset. Choose from: ${BOTTOM_FRAME_PRESETS.join(', ')}`,
      });
    }

    const { isPremiumUser, isFreeUser } = detectUserTier(req);

    // Free users get watermark; premium users don't
    const hasWatermark = isFreeUser;

    const jobId = generateJobId();
    const clipId = 'clip_' + Date.now();

    const job = {
      jobId,
      clipId,
      status: 'queued',
      progress: 0,
      stage: 'idle',
      message: 'Job queued',
      result: null,
      createdAt: new Date().toISOString(),
      config: {
        facecamUri,
        gameplayUri,
        streamerName,
        socialHandles: socialHandles || {},
        bottomFramePreset,
        hasWatermark,
      },
    };

    jobs.set(jobId, job);

    // Simulate async processing
    simulateStreamClipGeneration(jobId);

    return res.json({ jobId, status: 'processing', isPremiumUser, hasWatermark });
  } catch (error) {
    console.error('Stream clip generation error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

// ─── Simulated Stream Clip Generation ──────────────────────────────────────────

async function simulateStreamClipGeneration(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  const stages = [
    { progress: 15, stage: 'analyzing_facecam', message: 'Analyzing facecam video...' },
    { progress: 30, stage: 'cropping_facecam', message: 'Cropping facecam to 16:9 box...' },
    { progress: 45, stage: 'positioning_gameplay', message: 'Positioning gameplay video...' },
    { progress: 60, stage: 'loading_bottom_preset', message: `Loading bottom preset: ${job.config.bottomFramePreset}...` },
    { progress: 75, stage: 'applying_overlay', message: 'Applying streamer banner overlay...' },
    { progress: 85, stage: 'adding_social_icons', message: 'Adding social media handle badges...' },
    { progress: 92, stage: 'rendering_video', message: 'Rendering final 9:16 vertical video...' },
    { progress: 98, stage: 'injecting_watermark', message: job.config.hasWatermark ? 'Injecting watermark...' : 'Generating clean premium video...' },
  ];

  for (const s of stages) {
    await new Promise(r => setTimeout(r, 1200));
    job.progress = s.progress;
    job.stage = s.stage;
    job.message = s.message;
    jobs.set(jobId, job);
  }

  // Complete
  job.progress = 100;
  job.stage = 'complete';
  job.message = 'Stream clip generated successfully!';
  job.result = {
    success: true,
    clipId: job.clipId,
    streamerName: job.config.streamerName,
    bottomFramePreset: job.config.bottomFramePreset,
    socialHandles: job.config.socialHandles,
    hasWatermark: job.config.hasWatermark,
    outputUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4', // sample output
    createdAt: new Date().toISOString(),
  };
  jobs.set(jobId, job);
}

// ─── Get Stream Clip Status ───────────────────────────────────────────────────

function getStreamClipStatus(req, res) {
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

module.exports = { generateStreamClip, getStreamClipStatus };
