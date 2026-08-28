const express = require('express');
const router = express.Router();
const { generateStreamClip, getStreamClipStatus } = require('../controllers/gamingLayoutController');

// POST /api/generate-stream-clip — Submit stream clip generation job
router.post('/generate-stream-clip', generateStreamClip);

// GET /api/stream-clip-status/:jobId — Poll stream clip progress & result
router.get('/stream-clip-status/:jobId', getStreamClipStatus);

module.exports = router;
