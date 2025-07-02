const Redis = require('redis');

const createRateLimiter = (redisClient) => {
  const limits = {
    sync: { requests: 10, window: 1000 },
    async: { requests: 10, window: 1000 }
  };

  const checkLimit = async (vendor) => {
    const key = `rate_limit:${vendor}`;
    const now = Date.now();
    const windowStart = now - limits[vendor].window;
    
    const pipeline = redisClient.multi();
    pipeline.zRemRangeByScore(key, 0, windowStart);
    pipeline.zAdd(key, { score: now, value: `${now}-${Math.random()}` });
    pipeline.zCard(key);
    pipeline.expire(key, 2);
    
    const results = await pipeline.exec();
    const currentCount = results[2];
    
    return {
      allowed: currentCount <= limits[vendor].requests,
      currentCount,
      limit: limits[vendor].requests,
      resetTime: now + limits[vendor].window
    };
  };

  const getRemainingRequests = async (vendor) => {
    const key = `rate_limit:${vendor}`;
    const now = Date.now();
    const windowStart = now - limits[vendor].window;
    
    await redisClient.zRemRangeByScore(key, 0, windowStart);
    const currentCount = await redisClient.zCard(key);
    
    return Math.max(0, limits[vendor].requests - currentCount);
  };

  const waitForAvailability = async (vendor) => {
    const result = await checkLimit(vendor);
    
    if (result.allowed) {
      return true;
    }
    
    const waitTime = Math.max(0, result.resetTime - Date.now());
    
    return new Promise(resolve => {
      setTimeout(() => resolve(true), waitTime);
    });
  };

  return {
    checkLimit,
    getRemainingRequests,
    waitForAvailability
  };
};

module.exports = createRateLimiter; 