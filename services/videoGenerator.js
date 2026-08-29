/**
 * Video Generation Service using Replicate API
 * With timeout and progress updates
 */

const Replicate = require('replicate');

let replicate = null;
const VIDEO_TIMEOUT_MS = 90000; // 90 second timeout
const POLL_INTERVAL_MS = 3000; // 3 seconds between polls

function getReplicateClient() {
  if (!replicate) {
    const apiKey = process.env.REPLICATE_API_TOKEN;
    if (!apiKey) {
      console.error('[VideoGenerator] REPLICATE_API_TOKEN not configured');
      return null;
    }
    try {
      replicate = new Replicate({ auth: apiKey });
      console.log('[VideoGenerator] Client initialized');
    } catch (error) {
      console.error('[VideoGenerator] Failed to init:', error.message);
      return null;
    }
  }
  return replicate;
}

// Video models
const VIDEO_MODELS = {
  realistic: 'stability-ai/stable-video-diffusion',
  anime: 'anotherjesse/zeroscope-v2-xl',
  artistic: 'toppir/animagine'
};

/**
 * Generate video with timeout and progress
 */
async function generateVideo(prompt, style = 'realistic', progressCallback = null) {
  const client = getReplicateClient();
  if (!client) {
    console.warn('[VideoGenerator] No client, using fallback');
    return null;
  }

  const modelVersion = VIDEO_MODELS[style] || VIDEO_MODELS.realistic;
  console.log(`[VideoGenerator] Generating ${style} video...`);
  console.log(`[VideoGenerator] Model: ${modelVersion}`);

  try {
    // Create prediction with timeout
    let prediction;
    try {
      prediction = await Promise.race([
        client.predictions.create({
          version: `${modelVersion}:e27c5f6c95`,
          input: {
            prompt: prompt,
            video_length: '14frames',
            fps: 4,
            motion_bucket_id: 127
          }
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout creating prediction')), VIDEO_TIMEOUT_MS)
        )
      ]);
    } catch (error) {
      console.error(`[VideoGenerator] Failed to create prediction: ${error.message}`);
      return null;
    }

    console.log(`[VideoGenerator] Prediction: ${prediction.id}`);

    // Poll for completion with progress updates
    let result = prediction;
    const maxAttempts = 30; // 30 * 3s = 90s total
    
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      
      try {
        result = await Promise.race([
          client.predictions.get(result.id),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout polling')), 10000)
          )
        ]);
        
        console.log(`[VideoGenerator] Status: ${result.status} (${i + 1}/${maxAttempts})`);
        
        // Update progress if callback provided
        if (progressCallback && result.status === 'processing') {
          const progress = 70 + Math.floor((i / maxAttempts) * 25); // 70% to 95%
          progressCallback(progress);
        }
        
        if (result.status === 'succeeded') {
          console.log(`[VideoGenerator] ✅ Success!`);
          if (progressCallback) progressCallback(100);
          return result.output?.[0] || result.output;
        }
        
        if (result.status === 'failed') {
          throw new Error(result.error || 'Generation failed');
        }
      } catch (pollError) {
        console.warn(`[VideoGenerator] Poll error: ${pollError.message}`);
        continue;
      }
    }
    
    throw new Error('Timeout: Max attempts reached');
  } catch (error) {
    console.error(`[VideoGenerator] ❌ Error: ${error.message}`);
    return null; // Fallback to local video
  }
}

/**
 * Generate videos for multiple scenes
 */
async function generateFilmVideos(scenes, visualStyle, progressCallback = null) {
  const results = [];
  
  for (let i = 0; i < scenes.length; i++) {
    console.log(`[VideoGenerator] Scene ${i + 1}/${scenes.length}...`);
    
    if (progressCallback) {
      const sceneProgress = 70 + Math.floor((i / scenes.length) * 20); // 70% to 90%
      progressCallback(sceneProgress);
    }
    
    try {
      const videoUrl = await generateVideo(scenes[i].visual_prompt, visualStyle, progressCallback);
      results.push({ 
        video_url: videoUrl, 
        duration: scenes[i].duration_seconds 
      });
    } catch (error) {
      console.warn(`[VideoGenerator] Scene ${i + 1} failed:`, error.message);
      results.push({ 
        video_url: null,
        duration: scenes[i].duration_seconds,
        error: error.message 
      });
    }
    
    // Delay between requests
    if (i < scenes.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  if (progressCallback) {
    progressCallback(95);
  }
  
  return results;
}

module.exports = { generateVideo, generateFilmVideos };
