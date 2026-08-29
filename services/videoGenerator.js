/**
 * Video Generation Service using Replicate API
 */

const Replicate = require('replicate');
const https = require('https');

// Disable TLS verification for development
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let replicate = null;

function getReplicateClient() {
  if (!replicate) {
    const apiKey = process.env.REPLICATE_API_TOKEN;
    if (!apiKey) {
      console.warn('[VideoGenerator] REPLICATE_API_TOKEN not configured in environment');
      return null;
    }
    try {
      replicate = new Replicate({
        auth: apiKey,
      });
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
 */
async function generateVideo(prompt, style = 'realistic') {
  const client = getReplicateClient();
  if (!client) {
    console.warn('[VideoGenerator] No client available, returning null fallback');
    return null;
  }

  console.log('[VideoGenerator] Generating video for prompt:', prompt.substring(0, 60));

  const modelAttempts = [
    'anotherjesse/zeroscope-v2-xl',
    'stability-ai/sdxl-video'
  ];

  let prediction = null;

  for (const modelName of modelAttempts) {
    try {
      console.log('[VideoGenerator] Trying model:', modelName);

      try {
        prediction = await client.predictions.create({
          model: modelName,
          input: {
            prompt: prompt,
            num_inference_steps: 25,
            guidance_scale: 7.5,
            width: 1024,
            height: 576
          }
        });
        console.log('[VideoGenerator] Prediction created:', prediction.id);
        break;
      } catch (error) {
        console.warn('[VideoGenerator]', modelName, 'failed:', error.message);

        // If 401 Unauthenticated, token is invalid - fail fast
        if (error.message?.includes('401') || error.message?.includes('Unauthenticated') || error.message?.includes('token')) {
          console.warn('[VideoGenerator] Replicate token is unauthorized/expired. Returning null fallback.');
          return null;
        }

        // Handle rate limiting
        if (error.message?.includes('429') || error.message?.includes('rate limit')) {
          console.log('[VideoGenerator] Rate limited, skipping Replicate retry to avoid hanging.');
          return null;
        }
        continue;
      }
    } catch (error) {
      console.error('[VideoGenerator] Model attempt error:', error.message);
      if (error.message?.includes('401') || error.message?.includes('Unauthenticated')) return null;
      continue;
    }
  }

  if (!prediction) {
    console.warn('[VideoGenerator] No video prediction started, using dynamic visual artwork');
    return null;
  }

  // Poll for completion (max 12s)
  let result = prediction;
  const maxAttempts = 6; // 6 * 2s = 12s max

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      result = await client.predictions.get(result.id);
      console.log('[VideoGenerator] Status:', result.status, '(' + (i + 1) + '/' + maxAttempts + ')');

      if (result.status === 'succeeded') {
        console.log('[VideoGenerator] Success!');
        const output = result.output;
        if (Array.isArray(output)) {
          return output[0];
        }
        if (output && typeof output === 'object' && typeof output.url === 'function') {
          return output.url();
        }
        return output ? String(output) : null;
      }

      if (result.status === 'failed' || result.status === 'canceled') {
        console.warn('[VideoGenerator] Generation status failed:', result.error);
        return null;
      }
    } catch (pollError) {
      console.warn('[VideoGenerator] Poll error:', pollError.message);
      break;
    }
  }

  console.warn('[VideoGenerator] Timed out waiting for video generation, using dynamic AI art backdrop');
  return null;
}

/**
 * Generate videos for multiple scenes in parallel
 */
async function generateFilmVideos(scenes, visualStyle, onProgress) {
  if (typeof onProgress === 'function') {
    onProgress(75);
  }

  const results = await Promise.all(scenes.map(async (scene, i) => {
    try {
      const videoUrl = await generateVideo(scene.visual_prompt, visualStyle);
      return { video_url: videoUrl, duration: scene.duration_seconds };
    } catch (error) {
      console.warn(`[VideoGenerator] Scene ${i + 1} error:`, error.message);
      return { video_url: null, duration: scene.duration_seconds };
    }
  }));

  if (typeof onProgress === 'function') {
    onProgress(85);
  }

  return results;
}

module.exports = {
  generateVideo,
  generateFilmVideos
};
