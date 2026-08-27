const express = require('express');
const router = express.Router();
const { generateIdea, generateFilm, getFilmStatus } = require('../controllers/filmController');

// POST /api/generate-idea — Generate AI film idea from genre
router.post('/generate-idea', generateIdea);

// POST /api/generate-film — Submit film generation job
router.post('/generate-film', generateFilm);

// GET /api/film-status/:jobId — Poll job progress & result
router.get('/film-status/:jobId', getFilmStatus);

module.exports = router;
