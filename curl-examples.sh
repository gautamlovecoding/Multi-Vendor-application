#!/bin/bash

BASE_URL="http://localhost:3000"

echo "Multi-Vendor Data Fetch Service - API Examples"
echo "=============================================="

echo "1. Health Check:"
curl -X GET $BASE_URL/health

echo -e "\n2. Submit Job:"
curl -X POST $BASE_URL/jobs \
  -H "Content-Type: application/json" \
  -d '{"userId": 12345, "action": "fetch_profile"}'

echo -e "\n3. Check Job Status (replace REQUEST_ID):"
echo "curl -X GET $BASE_URL/jobs/REQUEST_ID"

echo -e "\n4. System Metrics:"
curl -X GET $BASE_URL/metrics

echo -e "\n5. Vendor Health:"
echo "Sync: curl http://localhost:3001/health"
echo "Async: curl http://localhost:3002/health" 