const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  requestId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  originalPayload: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  vendor: {
    type: String,
    required: true,
    enum: ['sync', 'async']
  },
  status: {
    type: String,
    required: true,
    enum: ['pending', 'processing', 'complete', 'failed'],
    default: 'pending'
  },
  result: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  error: {
    type: String,
    default: null
  },
  vendorJobId: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  processedAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  }
});

jobSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

jobSchema.index({ createdAt: 1 });
jobSchema.index({ status: 1 });
jobSchema.index({ vendor: 1 });

module.exports = mongoose.model('Job', jobSchema); 