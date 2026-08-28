const mongoose = require('mongoose');

const affiliateSchema = new mongoose.Schema({
  referrerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  referredUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  referralCode: { type: String, required: true },
  bonusGranted: { type: Boolean, default: false },
  creditsEarned: { type: Number, default: 5 },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

// Prevent duplicate referrals
affiliateSchema.index({ referralCode: 1, referredUserId: 1 }, { unique: true });

module.exports = mongoose.model('Affiliate', affiliateSchema);
