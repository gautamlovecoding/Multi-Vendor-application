const express = require('express');
const mongoose = require('mongoose');
const Redis = require('redis');
const Queue = require('bull');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
const _ = require('lodash');

const Job = require('./models/job');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'server.log' })
  ]
});

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: 'Too many requests from this IP',
  standardHeaders: true,
  legacyHeaders: false
});

app.use(limiter);

const redisClient = Redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

const jobQueue = new Queue('vendor jobs', process.env.REDIS_URL || 'redis://localhost:6379');

const connectDatabase = async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/vendordb');
  logger.info('Connected to MongoDB');
};

const connectRedis = async () => {
  await redisClient.connect();
  logger.info('Connected to Redis');
};

const cleanData = (data) => {
  const sensitiveFields = ['password', 'ssn', 'credit', 'secret'];
  
  const cleanObject = (obj) => {
    if (_.isArray(obj)) {
      return obj.map(cleanObject);
    }
    
    if (_.isObject(obj)) {
      const cleaned = {};
      
      for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        const shouldRemove = sensitiveFields.some(field => lowerKey.includes(field));
        
        if (!shouldRemove) {
          cleaned[key] = cleanObject(value);
        }
      }
      
      return cleaned;
    }
    
    if (_.isString(obj)) {
      let cleaned = obj.trim();
      
      if (cleaned.match(/^\+?1?[2-9]\d{2}[2-9]\d{2}\d{4}$/)) {
        cleaned = cleaned.replace(/\D/g, '');
        if (cleaned.length === 10) {
          cleaned = `+1${cleaned}`;
        } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
          cleaned = `+${cleaned}`;
        }
      }
      
      if (cleaned.includes('@')) {
        cleaned = cleaned.toLowerCase();
      }
      
      return cleaned;
    }
    
    return obj;
  };
  
  return cleanObject(data);
};

app.post('/jobs', async (req, res) => {
  const requestId = uuidv4();
  const vendor = ['sync', 'async'][Math.floor(Math.random() * 2)];
  
  logger.info('Job submission received', {
    requestId,
    vendor,
    payloadSize: JSON.stringify(req.body).length
  });
  
  const job = new Job({
    requestId,
    originalPayload: req.body,
    vendor,
    status: 'pending'
  });
  
  await job.save();
  
  await jobQueue.add('process-job', {
    requestId,
    vendor,
    payload: req.body
  });
  
  res.json({ request_id: requestId });
});

app.get('/jobs/:requestId', async (req, res) => {
  const { requestId } = req.params;
  
  const job = await Job.findOne({ requestId });
  
  if (!job) {
    return res.status(404).json({
      error: 'Job not found',
      request_id: requestId
    });
  }
  
  const response = {
    request_id: requestId,
    status: job.status,
    vendor: job.vendor,
    created_at: job.createdAt,
    updated_at: job.updatedAt
  };
  
  if (job.processedAt) {
    response.processed_at = job.processedAt;
  }
  
  if (job.completedAt) {
    response.completed_at = job.completedAt;
  }
  
  if (job.status === 'complete' && job.result) {
    response.result = job.result;
  }
  
  if (job.status === 'failed' && job.error) {
    response.error = job.error;
  }
  
  res.json(response);
});

app.post('/vendor-webhook/:vendor', async (req, res) => {
  const { vendor } = req.params;
  const { jobId, success, data, error } = req.body;
  
  logger.info('Webhook received', {
    vendor,
    jobId,
    success
  });
  
  const job = await Job.findOne({ vendorJobId: jobId });
  
  if (!job) {
    logger.warn('Webhook for unknown job', { vendor, jobId });
    return res.status(404).json({ error: 'Job not found' });
  }
  
  if (success) {
    const cleanedData = cleanData(data);
    
    job.status = 'complete';
    job.result = cleanedData;
    job.completedAt = new Date();
  } else {
    job.status = 'failed';
    job.error = error || 'Unknown error from vendor';
  }
  
  await job.save();
  
  logger.info('Job updated from webhook', {
    requestId: job.requestId,
    vendor,
    status: job.status
  });
  
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/metrics', async (req, res) => {
  const totalJobs = await Job.countDocuments();
  const pendingJobs = await Job.countDocuments({ status: 'pending' });
  const processingJobs = await Job.countDocuments({ status: 'processing' });
  const completedJobs = await Job.countDocuments({ status: 'complete' });
  const failedJobs = await Job.countDocuments({ status: 'failed' });
  
  const queueWaiting = await jobQueue.waiting();
  const queueActive = await jobQueue.active();
  const queueCompleted = await jobQueue.completed();
  const queueFailed = await jobQueue.failed();
  
  res.json({
    jobs: {
      total: totalJobs,
      pending: pendingJobs,
      processing: processingJobs,
      completed: completedJobs,
      failed: failedJobs
    },
    queue: {
      waiting: queueWaiting.length,
      active: queueActive.length,
      completed: queueCompleted.length,
      failed: queueFailed.length
    },
    system: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString()
    }
  });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method
  });
  
  res.status(500).json({
    error: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  await connectDatabase();
  await connectRedis();
  
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
};

startServer().catch(err => {
  logger.error('Failed to start server', { error: err.message });
  process.exit(1);
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  
  await redisClient.quit();
  await mongoose.connection.close();
  
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason, promise });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  process.exit(1);
}); 