const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId: { type: String, unique: true, sparse: true },
  email: { type: String, unique: true, sparse: true, required: true },
  name: { type: String, required: true },
  photoUrl: { type: String },
  deviceId: { type: String, unique: true, sparse: true },
  isPremium: { type: Boolean, default: false },
  credits: { type: Number, default: 3 },
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// Generate referral code on save
userSchema.pre('save', function (next) {
  if (!this.referralCode) {
    this.referralCode = 'ZN' + Math.random().toString(36).substr(2, 6).toUpperCase();
  }
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('User', userSchema);
