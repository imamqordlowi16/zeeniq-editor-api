/**
 * Video Generation Service using Replicate API
 * Simple and reliable implementation
 */

const Replicate = require('replicate');

let replicate = null;
const VIDEO_TIMEOUT_MS = 180000; // 3 minute timeout
const RATE_LIMIT_DELAY_MS = 20000; // 20 seconds between requests

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

/**
 * Generate video using Replicate API
 * Uses dynamic model fetching to avoid hardcoded version hashes
 */
async function generateVideo(prompt, style = 'realistic') {
  const client = getReplicateClient();
  if (!client) {
    console.warn('[VideoGenerator] No client, using fallback');
    return null;
  }

  console.log(`[VideoGenerator] Generating video for prompt: ${prompt.substring(0, 50)}...`);

  try {
    // Get model and latest version dynamically
    let model;
    try {
      model = await client.models.get('stability-ai/stable-video-diffusion');
      console.log(`[VideoGenerator] Model found: ${model.name}`);
    } catch (err) {
      console.error(`[VideoGenerator] Model not found: ${err.message}`);
      return null;
    }

    const version = model.default_version?.id;
    if (!version) {
      console.error('[VideoGenerator] No default version found');
      return null;
    }

    console.log(`[VideoGenerator] Using version: ${version.substring(0, 40)}...`);

    // Create prediction
    let prediction;
    try {
      prediction = await client.predictions.create({
        version: version,
        input: {
          prompt: prompt,
          video_length: '14frames',
          fps: 4,
          motion_bucket_id: 127
        }
      });
      console.log(`[VideoGenerator] Prediction created: ${prediction.id}`);
    } catch (error) {
      console.error(`[VideoGenerator] Failed to create prediction: ${error.message}`);
      
      // Check if it's a rate limit error
      if (error.message.includes('429') || error.message.includes('rate limit')) {
        console.log('[VideoGenerator] Rate limited, will retry after delay');
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
        
        // Try one more time
        try {
          prediction = await client.predictions.create({
            version: version,
            input: {
              prompt: prompt,
              video_length: '14frames',
              fps: 4,
              motion_bucket_id: 127
            }
          });
          console.log(`[VideoGenerator] Retry success: ${prediction.id}`);
        } catch (retryError) {
          console.error(`[VideoGenerator] Retry also failed: ${retryError.message}`);
          return null;
        }
      } else {
        return null;
      }
    }

    if (!prediction) return null;

    // Poll for completion
    let result = prediction;
    const maxAttempts = 60;
    
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      try {
        result = await client.predictions.get(result.id);
        console.log(`[VideoGenerator] Status: ${result.status} (${i + 1}/${maxAttempts})`);
        
        if (result.status === 'succeeded') {
          console.log(`[VideoGenerator] ✅ Video generated successfully!`);
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
    
    throw new Error('Timeout: Max polling attempts reached');
  } catch (error) {
    console.error(`[VideoGenerator] ❌ Error: ${error.message}`);
    return null; // Fallback to local video
  }
}

/**
 * Generate videos for multiple scenes
 */
async function generateFilmVideos(scenes, visualStyle) {
  const results = [];
  
  for (let i = 0; i < scenes.length; i++) {
    console.log(`[VideoGenerator] Scene ${i + 1}/${scenes.length}...`);
    
    try {
      const videoUrl = await generateVideo(scenes[i].visual_prompt, visualStyle);
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
    
    // Rate limiting: wait between requests
    if (i < scenes.length - 1) {
      console.log(`[VideoGenerator] Waiting ${RATE_LIMIT_DELAY_MS/1000}s for rate limit...`);
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
    }
  }
  
  return results;
}

module.exports = { generateVideo, generateFilmVideos };
