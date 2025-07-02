const axios = require('axios');
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

const baseUrl = process.env.API_URL || 'http://localhost:3000';
const concurrentUsers = process.env.CONCURRENT_USERS || 200;
const testDuration = process.env.TEST_DURATION || 60000;

const metrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  jobsCreated: 0,
  jobsCompleted: 0,
  jobsFailed: 0,
  averageResponseTime: 0,
  responseTimes: [],
  errors: {}
};

const createdJobs = [];

const samplePayloads = [
  {
    userId: 12345,
    action: 'fetch_profile',
    timestamp: new Date().toISOString()
  },
  {
    customerId: 67890,
    requestType: 'data_enrichment',
    fields: ['email', 'phone', 'address'],
    priority: 'high'
  },
  {
    accountId: 'acc_' + Math.random().toString(36).substr(2, 9),
    operation: 'sync_data',
    source: 'external_api',
    filters: {
      dateRange: '30d',
      includeDeleted: false
    }
  },
  {
    transactionId: 'txn_' + Math.random().toString(36).substr(2, 9),
    type: 'verification',
    data: {
      amount: Math.floor(Math.random() * 10000),
      currency: 'USD',
      merchant: 'Test Merchant'
    }
  }
];

const recordMetric = (responseTime, success, error = null) => {
  metrics.totalRequests++;
  metrics.responseTimes.push(responseTime);
  
  if (success) {
    metrics.successfulRequests++;
  } else {
    metrics.failedRequests++;
    if (error) {
      const errorKey = error.code || error.message || 'unknown';
      metrics.errors[errorKey] = (metrics.errors[errorKey] || 0) + 1;
    }
  }
  
  const sum = metrics.responseTimes.reduce((a, b) => a + b, 0);
  metrics.averageResponseTime = sum / metrics.responseTimes.length;
};

const createJob = async () => {
  const startTime = Date.now();
  const payload = samplePayloads[Math.floor(Math.random() * samplePayloads.length)];
  
  const response = await axios.post(`${baseUrl}/jobs`, payload, {
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json'
    }
  });
  
  const responseTime = Date.now() - startTime;
  
  if (response.status === 200 && response.data.request_id) {
    recordMetric(responseTime, true);
    metrics.jobsCreated++;
    createdJobs.push({
      requestId: response.data.request_id,
      createdAt: Date.now()
    });
    
    return response.data.request_id;
  } else {
    recordMetric(responseTime, false, { message: 'Invalid response' });
    return null;
  }
};

const checkJobStatus = async (requestId) => {
  const startTime = Date.now();
  
  const response = await axios.get(`${baseUrl}/jobs/${requestId}`, {
    timeout: 5000
  });
  
  const responseTime = Date.now() - startTime;
  
  if (response.status === 200) {
    recordMetric(responseTime, true);
    
    const status = response.data.status;
    if (status === 'complete') {
      metrics.jobsCompleted++;
    } else if (status === 'failed') {
      metrics.jobsFailed++;
    }
    
    return response.data;
  } else {
    recordMetric(responseTime, false, { message: 'Status check failed' });
    return null;
  }
};

const simulateUser = async () => {
  const userId = Math.floor(Math.random() * 1000000);
  const startTime = Date.now();
  
  logger.info('Starting user simulation', { userId });
  
  while (Date.now() - startTime < testDuration) {
    const action = Math.random();
    
    if (action < 0.7) {
      await createJob().catch(err => {
        recordMetric(0, false, err);
        logger.error('Job creation failed', {
          userId,
          error: err.message
        });
      });
    } else if (createdJobs.length > 0) {
      const randomJob = createdJobs[Math.floor(Math.random() * createdJobs.length)];
      await checkJobStatus(randomJob.requestId).catch(err => {
        recordMetric(0, false, err);
        logger.error('Status check failed', {
          userId,
          requestId: randomJob.requestId,
          error: err.message
        });
      });
    }
    
    const waitTime = Math.floor(Math.random() * 1000) + 100;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  logger.info('User simulation completed', { userId });
};

const printMetrics = () => {
  const p95 = metrics.responseTimes.sort((a, b) => a - b)[Math.floor(metrics.responseTimes.length * 0.95)];
  const p99 = metrics.responseTimes.sort((a, b) => a - b)[Math.floor(metrics.responseTimes.length * 0.99)];
  
  console.log('\n=== LOAD TEST RESULTS ===');
  console.log(`Test Duration: ${testDuration / 1000}s`);
  console.log(`Concurrent Users: ${concurrentUsers}`);
  console.log(`Total Requests: ${metrics.totalRequests}`);
  console.log(`Successful Requests: ${metrics.successfulRequests}`);
  console.log(`Failed Requests: ${metrics.failedRequests}`);
  console.log(`Success Rate: ${((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(2)}%`);
  console.log(`Jobs Created: ${metrics.jobsCreated}`);
  console.log(`Jobs Completed: ${metrics.jobsCompleted}`);
  console.log(`Jobs Failed: ${metrics.jobsFailed}`);
  console.log(`Average Response Time: ${metrics.averageResponseTime.toFixed(2)}ms`);
  console.log(`95th Percentile: ${p95}ms`);
  console.log(`99th Percentile: ${p99}ms`);
  console.log(`Requests per Second: ${(metrics.totalRequests / (testDuration / 1000)).toFixed(2)}`);
  
  if (Object.keys(metrics.errors).length > 0) {
    console.log('\n=== ERRORS ===');
    for (const [error, count] of Object.entries(metrics.errors)) {
      console.log(`${error}: ${count}`);
    }
  }
  
  console.log('\n=== RECOMMENDATIONS ===');
  
  if (metrics.averageResponseTime > 2000) {
    console.log('⚠️  High average response time detected. Consider scaling up resources.');
  }
  
  if ((metrics.failedRequests / metrics.totalRequests) > 0.05) {
    console.log('⚠️  High error rate detected. Check system logs for issues.');
  }
  
  if (metrics.jobsCompleted < metrics.jobsCreated * 0.8) {
    console.log('⚠️  Low job completion rate. Check worker performance.');
  }
  
  if (p99 > 5000) {
    console.log('⚠️  High 99th percentile response time. Some requests are very slow.');
  }
  
  console.log('\n========================\n');
};

const runLoadTest = async () => {
  logger.info('Starting load test', {
    baseUrl,
    concurrentUsers,
    testDuration
  });
  
  const healthCheck = await axios.get(`${baseUrl}/health`).catch(() => null);
  
  if (!healthCheck) {
    logger.error('API server is not responding. Please start the server first.');
    process.exit(1);
  }
  
  logger.info('API server health check passed');
  
  const users = [];
  
  for (let i = 0; i < concurrentUsers; i++) {
    users.push(simulateUser());
  }
  
  const metricsInterval = setInterval(() => {
    logger.info('Current metrics', {
      totalRequests: metrics.totalRequests,
      successRate: `${((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(2)}%`,
      avgResponseTime: `${metrics.averageResponseTime.toFixed(2)}ms`,
      jobsCreated: metrics.jobsCreated,
      jobsCompleted: metrics.jobsCompleted
    });
  }, 10000);
  
  await Promise.all(users);
  
  clearInterval(metricsInterval);
  
  logger.info('Load test completed, waiting for final results...');
  
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  printMetrics();
};

runLoadTest().catch(err => {
  logger.error('Load test failed', { error: err.message });
  process.exit(1);
}); 