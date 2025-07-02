const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

const app = express();
app.use(express.json({ limit: '10mb' }));

const pendingJobs = new Map();

const generateMockUserData = () => {
  const users = [
    {
      id: Math.floor(Math.random() * 100000),
      name: 'Alice Johnson',
      email: 'alice.johnson@example.com',
      phone: '+1555123456',
      address: '789 Pine St, Elsewhere USA',
      creditScore: Math.floor(Math.random() * 300) + 500,
      accountBalance: Math.floor(Math.random() * 50000),
      lastLogin: new Date().toISOString(),
      passwordHash: 'hashed_password_123',
      preferences: {
        newsletter: true,
        notifications: true
      }
    },
    {
      id: Math.floor(Math.random() * 100000),
      name: 'Bob Wilson',
      email: 'bob.wilson@example.com',
      phone: '+1555987654',
      address: '321 Elm St, Nowhere USA',
      creditScore: Math.floor(Math.random() * 300) + 500,
      accountBalance: Math.floor(Math.random() * 50000),
      lastLogin: new Date().toISOString(),
      creditCardNumber: '4111-1111-1111-1111',
      preferences: {
        newsletter: false,
        notifications: false
      }
    }
  ];
  
  return users[Math.floor(Math.random() * users.length)];
};

const processJobAsync = async (jobId, originalPayload) => {
  const processingTime = Math.floor(Math.random() * 5000) + 2000;
  
  logger.info('Async vendor processing job', {
    jobId,
    processingTime
  });
  
  setTimeout(async () => {
    const webhookUrl = `${process.env.WEBHOOK_BASE_URL}/vendor-webhook/async`;
    
    if (Math.random() < 0.03) {
      logger.error('Async vendor simulated error', { jobId });
      
      const errorPayload = {
        jobId,
        success: false,
        error: 'Async vendor processing failed',
        code: 'ASYNC_VENDOR_ERROR',
        processedAt: new Date().toISOString()
      };
      
      await axios.post(webhookUrl, errorPayload).catch(err => {
        logger.error('Failed to send error webhook', {
          jobId,
          error: err.message
        });
      });
      
      pendingJobs.delete(jobId);
      return;
    }
    
    const userData = generateMockUserData();
    
    const successPayload = {
      jobId,
      success: true,
      data: userData,
      vendor: 'async',
      processedAt: new Date().toISOString()
    };
    
    logger.info('Async vendor completed job, sending webhook', {
      jobId,
      userId: userData.id
    });
    
    await axios.post(webhookUrl, successPayload).catch(err => {
      logger.error('Failed to send success webhook', {
        jobId,
        error: err.message
      });
    });
    
    pendingJobs.delete(jobId);
  }, processingTime);
};

app.post('/fetch-data', async (req, res) => {
  const jobId = uuidv4();
  
  logger.info('Async vendor received request', {
    jobId,
    payload: req.body
  });
  
  pendingJobs.set(jobId, {
    status: 'processing',
    createdAt: new Date().toISOString(),
    payload: req.body
  });
  
  processJobAsync(jobId, req.body);
  
  res.json({
    success: true,
    jobId,
    status: 'processing',
    vendor: 'async',
    estimatedCompletionTime: new Date(Date.now() + 7000).toISOString()
  });
});

app.get('/job/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = pendingJobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({
      error: 'Job not found',
      jobId
    });
  }
  
  res.json({
    jobId,
    status: job.status,
    createdAt: job.createdAt,
    vendor: 'async'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    vendor: 'async',
    pendingJobs: pendingJobs.size,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3002;

app.listen(PORT, () => {
  logger.info(`Async vendor service running on port ${PORT}`);
}); 