/**
 * Video Generation Service using Alternative Models
 * More reliable than Stable Video Diffusion
 */

const Replicate = require('replicate');

let replicate = null;
const VIDEO_TIMEOUT_MS = 180000;
const RATE_LIMIT_DELAY_MS = 25000;

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

async function getLatestModelVersion(modelName) {
  const client = getReplicateClient();
  if (!client) return null;

  try {
    const model = await client.models.get(modelName);
    return model?.default_version?.id || null;
  } catch (error) {
    console.warn('[VideoGenerator] Failed to get ' + modelName + ':', error.message);
    return null;
  }
}

async function generateVideo(prompt, style) {
  if (style === void 0) { style = 'realistic'; }
  var _a, _b;
  const client = getReplicateClient();
  if (!client) {
    console.warn('[VideoGenerator] No client, using fallback');
    return null;
  }

  console.log('[VideoGenerator] Generating video...');
  console.log('[VideoGenerator] Prompt:', prompt.substring(0, 50));

  const modelAttempts = [
    'anotherjesse/zeroscope-v2-xl',
    'stability-ai/sdxl-video',
    'stability-ai/stable-video-diffusion'
  ];

  let prediction = null;

  for (const modelName of modelAttempts) {
    try {
      console.log('[VideoGenerator] Trying:', modelName);

      const version = await getLatestModelVersion(modelName);
      if (!version) {
        console.warn('[VideoGenerator]', modelName, 'not available');
        continue;
      }

      console.log('[VideoGenerator] Using version:', version.substring(0, 40));

      try {
        prediction = await client.predictions.create({
          version: version,
          input: {
            prompt: prompt,
            num_inference_steps: 25,
            video_length: '14frames',
            framerate: 4,
            motion_bucket_id: 127
          }
        });
        console.log('[VideoGenerator] Prediction:', prediction.id);
        break;
      } catch (error) {
        console.warn('[VideoGenerator]', modelName, 'failed:', error.message);

        if (error.message.includes('429')) {
          console.log('[VideoGenerator] Rate limited, waiting...');
          await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));

          try {
            prediction = await client.predictions.create({
              version: version,
              input: {
                prompt: prompt,
                num_inference_steps: 25,
                video_length: '14frames',
                framerate: 4,
                motion_bucket_id: 127
              }
            });
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
    console.error('[VideoGenerator] All models failed');
    return null;
  }

  let result = prediction;
  const maxAttempts = 60;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 3000));

    try {
      result = await client.predictions.get(result.id);
      console.log('[VideoGenerator] Status:', result.status, '(' + (i + 1) + '/' + maxAttempts + ')');

      if (result.status === 'succeeded') {
        console.log('[VideoGenerator] Success!');
        return (_b = (_a = result.output) === null || _a === void 0 ? void 0 : _a[0]) !== null && _b !== void 0 ? _b : result.output;
      }

      if (result.status === 'failed') {
        throw new Error(result.error || 'Generation failed');
      }
    } catch (pollError) {
      console.warn('[VideoGenerator] Poll error:', pollError.message);
      continue;
    }
  }

  throw new Error('Timeout');
}

async function generateFilmVideos(scenes, visualStyle) {
  const results = [];

  for (let i = 0; i < scenes.length; i++) {
    console.log('[VideoGenerator] Scene', i + 1, '/', scenes.length);

    try {
      const videoUrl = await generateVideo(scenes[i].visual_prompt, visualStyle);
      results.push({ video_url: videoUrl, duration: scenes[i].duration_seconds });
    } catch (error) {
      console.warn('[VideoGenerator] Scene', i + 1, 'failed:', error.message);
      results.push({ video_url: null, duration: scenes[i].duration_seconds });
    }

    if (i < scenes.length - 1) {
      console.log('[VideoGenerator] Waiting', RATE_LIMIT_DELAY_MS / 1000, 's...');
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
    }
  }

  return results;
}

module.exports = { generateVideo, generateFilmVideos };
