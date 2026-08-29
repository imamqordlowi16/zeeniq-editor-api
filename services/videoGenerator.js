/**
 * Video Generation Service
 * Uses Replicate API with fallback to local assets
 */

const Replicate = require('replicate');

let replicate = null;

function getReplicateClient() {
  if (!replicate) {
    const apiKey = process.env.REPLICATE_API_TOKEN;
    if (!apiKey) {
      console.error('[VideoGenerator] REPLICATE_API_TOKEN not configured');
      return null;
    }
    try {
      replicate = new Replicate({ auth: apiKey });
    } catch (error) {
      console.error('[VideoGenerator] Failed to initialize Replicate:', error.message);
      return null;
    }
  }
  return replicate;
}

// Known working video models on Replicate
const VIDEO_MODELS = {
  realistic: 'stability-ai/stable-video-diffusion',
  anime: 'anotherjesse/zeroscope-v2-xl',
  artistic: 'toppir/animagine'
};

/**
 * Generate a video from text prompt using Replicate
 * Falls back to null if API fails
 */
async function generateVideo(prompt, style = 'realistic') {
  const client = getReplicateClient();
  if (!client) {
    console.warn('[VideoGenerator] Replicate client not available, using fallback');
    return null;
  }

  const modelVersion = VIDEO_MODELS[style] || VIDEO_MODELS.realistic;

  console.log(`[VideoGenerator] Generating ${style} video from prompt...`);

  try {
    const prediction = await client.predictions.create({
      version: `${modelVersion}:e27c5f6c95`,
      input: {
        prompt: prompt,
        video_length: '14frames',
        fps: 4,
        motion_bucket_id: 127
      }
    });

    // Poll for completion
    let result = prediction;
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      result = await client.predictions.get(result.id);
      
      if (result.status === 'succeeded') {
        console.log(`[VideoGenerator] Video generated successfully!`);
        return result.output?.[0] || result.output;
      }
      
      if (result.status === 'failed') {
        throw new Error(result.error || 'Video generation failed');
      }
      
      console.log(`[VideoGenerator] Progress: ${Math.round((i / maxAttempts) * 100)}%`);
    }
    
    throw new Error('Video generation timed out');
  } catch (error) {
    console.error('[VideoGenerator] Error:', error.message);
    return null; // Return null to use fallback
  }
}

/**
 * Generate videos for multiple scenes
 * Returns array with video URLs or null for fallback
 */
async function generateFilmVideos(scenes, visualStyle) {
  const results = [];
  
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    
    console.log(`[VideoGenerator] Generating scene ${i + 1}/${scenes.length}...`);
    
    try {
      const videoUrl = await generateVideo(scene.visual_prompt, visualStyle);
      results.push({ 
        video_url: videoUrl, 
        duration: scene.duration_seconds 
      });
    } catch (error) {
      console.warn(`[VideoGenerator] Scene ${i + 1} failed:`, error.message);
      results.push({ 
        video_url: null, // Will use local fallback
        duration: scene.duration_seconds,
        error: error.message 
      });
    }
    
    // Rate limiting delay
    if (i < scenes.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  return results;
}

module.exports = { generateVideo, generateFilmVideos };
