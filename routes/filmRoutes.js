const express = require('express');
const router = express.Router();
const { generateIdea, generateFilm, getFilmStatus, generateAffiliateVideo, getAffiliateVideoStatus } = require('../controllers/filmController');

// POST /api/generate-idea — Generate AI film idea from genre
router.post('/generate-idea', generateIdea);

// POST /api/generate-film — Submit film generation job
router.post('/generate-film', generateFilm);

// GET /api/film-status/:jobId — Poll job progress & result
router.get('/film-status/:jobId', getFilmStatus);

// POST /api/generate-affiliate-video — Submit affiliate video generation job
router.post('/generate-affiliate-video', generateAffiliateVideo);

// GET /api/affiliate-video-status/:jobId — Poll affiliate job progress & result
router.get('/affiliate-video-status/:jobId', getAffiliateVideoStatus);

module.exports = router;
