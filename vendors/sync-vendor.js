const express = require('express');
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

const generateMockUserData = () => {
  const users = [
    {
      id: Math.floor(Math.random() * 100000),
      name: 'John Doe',
      email: 'john.doe@example.com',
      phone: '+1234567890',
      address: '123 Main St, Anytown USA',
      creditScore: Math.floor(Math.random() * 300) + 500,
      accountBalance: Math.floor(Math.random() * 50000),
      lastLogin: new Date().toISOString(),
      preferences: {
        newsletter: true,
        notifications: false
      }
    },
    {
      id: Math.floor(Math.random() * 100000),
      name: 'Jane Smith',
      email: 'jane.smith@example.com',
      phone: '+1987654321',
      address: '456 Oak Ave, Somewhere USA',
      creditScore: Math.floor(Math.random() * 300) + 500,
      accountBalance: Math.floor(Math.random() * 50000),
      lastLogin: new Date().toISOString(),
      socialSecurityNumber: '123-45-6789',
      preferences: {
        newsletter: false,
        notifications: true
      }
    }
  ];
  
  return users[Math.floor(Math.random() * users.length)];
};

app.post('/fetch-data', async (req, res) => {
  const processingTime = Math.floor(Math.random() * 2000) + 500;
  
  logger.info('Sync vendor received request', {
    payload: req.body,
    processingTime
  });
  
  setTimeout(() => {
    if (Math.random() < 0.05) {
      logger.error('Sync vendor simulated error');
      return res.status(500).json({
        error: 'Internal server error',
        code: 'SYNC_VENDOR_ERROR'
      });
    }
    
    const userData = generateMockUserData();
    
    logger.info('Sync vendor returning data', {
      userId: userData.id,
      processingTime
    });
    
    res.json({
      success: true,
      data: userData,
      vendor: 'sync',
      processedAt: new Date().toISOString()
    });
  }, processingTime);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    vendor: 'sync',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  logger.info(`Sync vendor service running on port ${PORT}`);
}); 