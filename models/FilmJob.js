const mongoose = require('mongoose');

const sceneSchema = new mongoose.Schema({
  scene_number: { type: Number, required: true },
  visual_prompt: { type: String, required: true },
  narration: { type: String },
  duration_seconds: { type: Number },
  art_direction: { type: String },
  audio_url: { type: String },
}, { _id: false });

const filmJobSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true },
  filmId: { type: String },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  userEmail: { type: String },
  prompt: { type: String },
  title: { type: String },
  plotType: { type: String },
  voiceStyle: { type: String },
  visualStyle: { type: String },
  filmTheme: { type: String },
  logline: { type: String },
  status: { type: String, enum: ['queued', 'processing', 'completed', 'failed'], default: 'queued' },
  progress: { type: Number, default: 0 },
  stage: { type: String },
  message: { type: String },
  videoUrl: { type: String },
  scenes: [sceneSchema],
  result: { type: mongoose.Schema.Types.Mixed },
  hasWatermark: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

// Index for quick lookups
filmJobSchema.index({ jobId: 1 });
filmJobSchema.index({ userId: 1, createdAt: -1 });
filmJobSchema.index({ userEmail: 1 });

module.exports = mongoose.model('FilmJob', filmJobSchema);
