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

        // Handle rate limiting
        if (error.message?.includes('429') || error.message?.includes('rate limit')) {
          console.log('[VideoGenerator] Rate limited, waiting 15s...');
          await new Promise(resolve => setTimeout(resolve, 15000));

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
            console.log('[VideoGenerator] Retry success');
            break;
          } catch (retryError) {
            console.error('[VideoGenerator] Retry failed:', retryError.message);
            continue;
          }
        }
        continue;
      }
    } catch (error) {
      console.error('[VideoGenerator] Model attempt error:', error.message);
      continue;
    }
  }

  if (!prediction) {
    console.warn('[VideoGenerator] All video models failed, using fallback');
    return null;
  }

  // Poll for completion
  let result = prediction;
  const maxAttempts = 60;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 3000));

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

      if (result.status === 'failed') {
        console.warn('[VideoGenerator] Generation status failed:', result.error);
        return null;
      }
    } catch (pollError) {
      console.warn('[VideoGenerator] Poll error:', pollError.message);
      continue;
    }
  }

  console.warn('[VideoGenerator] Timed out waiting for video generation');
  return null;
}

/**
 * Generate videos for multiple scenes
 */
async function generateFilmVideos(scenes, visualStyle, onProgress) {
  const results = [];

  for (let i = 0; i < scenes.length; i++) {
    console.log(`[VideoGenerator] Generating scene ${i + 1}/${scenes.length}`);
    if (typeof onProgress === 'function') {
      const p = 70 + Math.round((i / scenes.length) * 15);
      onProgress(p);
    }

    try {
      const videoUrl = await generateVideo(scenes[i].visual_prompt, visualStyle);
      results.push({ video_url: videoUrl, duration: scenes[i].duration_seconds });
    } catch (error) {
      console.warn(`[VideoGenerator] Scene ${i + 1} failed:`, error.message);
      results.push({ video_url: null, duration: scenes[i].duration_seconds });
    }

    if (i < scenes.length - 1) {
      console.log('[VideoGenerator] Waiting 5s before next scene...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  return results;
}

module.exports = { generateVideo, generateFilmVideos };
