const mongoose = require('mongoose');
const Redis = require('redis');
const Queue = require('bull');
const axios = require('axios');
const winston = require('winston');
const _ = require('lodash');

const Job = require('./models/job');
const createRateLimiter = require('./utils/rate-limiter');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'worker.log' })
  ]
});

const redisClient = Redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

const jobQueue = new Queue('vendor jobs', process.env.REDIS_URL || 'redis://localhost:6379');
const rateLimiter = createRateLimiter(redisClient);

const vendorUrls = {
  sync: process.env.SYNC_VENDOR_URL || 'http://localhost:3001',
  async: process.env.ASYNC_VENDOR_URL || 'http://localhost:3002'
};

const connectDatabase = async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/vendordb');
  logger.info('Worker connected to MongoDB');
};

const connectRedis = async () => {
  await redisClient.connect();
  logger.info('Worker connected to Redis');
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

const callSyncVendor = async (payload) => {
  const response = await axios.post(`${vendorUrls.sync}/fetch-data`, payload, {
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json'
    }
  });
  
  return response.data;
};

const callAsyncVendor = async (payload) => {
  const response = await axios.post(`${vendorUrls.async}/fetch-data`, payload, {
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json'
    }
  });
  
  return response.data;
};

const processJob = async (jobData) => {
  const { requestId, vendor, payload } = jobData;
  
  logger.info('Processing job', {
    requestId,
    vendor,
    payloadSize: JSON.stringify(payload).length
  });
  
  const job = await Job.findOne({ requestId });
  
  if (!job) {
    logger.error('Job not found in database', { requestId });
    throw new Error('Job not found');
  }
  
  job.status = 'processing';
  job.processedAt = new Date();
  await job.save();
  
  await rateLimiter.waitForAvailability(vendor);
  
  const rateLimitCheck = await rateLimiter.checkLimit(vendor);
  
  if (!rateLimitCheck.allowed) {
    logger.warn('Rate limit exceeded, requeueing job', {
      requestId,
      vendor,
      currentCount: rateLimitCheck.currentCount,
      limit: rateLimitCheck.limit
    });
    
    throw new Error('Rate limit exceeded');
  }
  
  logger.info('Rate limit check passed', {
    requestId,
    vendor,
    remaining: rateLimitCheck.limit - rateLimitCheck.currentCount
  });
  
  if (vendor === 'sync') {
    const vendorResponse = await callSyncVendor(payload);
    
    if (vendorResponse.success) {
      const cleanedData = cleanData(vendorResponse.data);
      
      job.status = 'complete';
      job.result = cleanedData;
      job.completedAt = new Date();
      
      logger.info('Sync job completed successfully', {
        requestId,
        dataPoints: Object.keys(cleanedData).length
      });
    } else {
      job.status = 'failed';
      job.error = vendorResponse.error || 'Sync vendor returned unsuccessful response';
      
      logger.error('Sync job failed', {
        requestId,
        error: job.error
      });
    }
    
    await job.save();
    
  } else if (vendor === 'async') {
    const vendorResponse = await callAsyncVendor(payload);
    
    if (vendorResponse.success && vendorResponse.jobId) {
      job.vendorJobId = vendorResponse.jobId;
      job.status = 'processing';
      
      logger.info('Async job submitted to vendor', {
        requestId,
        vendorJobId: vendorResponse.jobId,
        estimatedCompletion: vendorResponse.estimatedCompletionTime
      });
    } else {
      job.status = 'failed';
      job.error = 'Failed to submit job to async vendor';
      
      logger.error('Async job submission failed', {
        requestId,
        vendorResponse
      });
    }
    
    await job.save();
  }
};

jobQueue.process('process-job', 5, async (job) => {
  const startTime = Date.now();
  
  await processJob(job.data);
  
  const processingTime = Date.now() - startTime;
  
  logger.info('Job processing completed', {
    requestId: job.data.requestId,
    vendor: job.data.vendor,
    processingTime
  });
});

jobQueue.on('completed', (job, result) => {
  logger.info('Queue job completed', {
    jobId: job.id,
    requestId: job.data.requestId
  });
});

jobQueue.on('failed', (job, err) => {
  logger.error('Queue job failed', {
    jobId: job.id,
    requestId: job.data.requestId,
    error: err.message,
    attempts: job.attemptsMade,
    maxAttempts: job.opts.attempts
  });
  
  if (job.attemptsMade >= (job.opts.attempts || 3)) {
    Job.findOneAndUpdate(
      { requestId: job.data.requestId },
      {
        status: 'failed',
        error: `Job failed after ${job.attemptsMade} attempts: ${err.message}`
      }
    ).catch(updateErr => {
      logger.error('Failed to update job status', {
        requestId: job.data.requestId,
        error: updateErr.message
      });
    });
  }
});

jobQueue.on('stalled', (job) => {
  logger.warn('Queue job stalled', {
    jobId: job.id,
    requestId: job.data.requestId
  });
});

const gracefulShutdown = async () => {
  logger.info('Worker shutting down gracefully');
  
  await jobQueue.close();
  await redisClient.quit();
  await mongoose.connection.close();
  
  process.exit(0);
};

const startWorker = async () => {
  await connectDatabase();
  await connectRedis();
  
  logger.info('Worker started, waiting for jobs');
  
  setInterval(async () => {
    const waiting = await jobQueue.waiting();
    const active = await jobQueue.active();
    const completed = await jobQueue.completed();
    const failed = await jobQueue.failed();
    
    logger.info('Queue statistics', {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      timestamp: new Date().toISOString()
    });
  }, 30000);
};

startWorker().catch(err => {
  logger.error('Failed to start worker', { error: err.message });
  process.exit(1);
});

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection in worker', { reason, promise });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception in worker', { 
    error: error.message, 
    stack: error.stack 
  });
  process.exit(1);
}); 