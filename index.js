const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5003;

const IMAGE_SERVICE_URL = process.env.IMAGE_SERVICE_URL || 'http://localhost:5001';

app.use(cors());
app.use(express.json());

// Fetch image from "image_service by ZeferinoA"
async function fetchImageFromService(imageId) {
  try {
    const response = await axios.get(`${IMAGE_SERVICE_URL}/image/${imageId}`, {
      responseType: 'arraybuffer',
      timeout: 10000
    });

    // Get file extension from content-type or default to jpg
    const contentType = response.headers['content-type'];
    let extension = '.jpg';
    if (contentType) {
      if (contentType.includes('png')) extension = '.png';
      else if (contentType.includes('pdf')) extension = '.pdf';
      else if (contentType.includes('jpeg') || contentType.includes('jpg')) extension = '.jpg';
    }

    return {
      data: response.data,
      extension: extension,
      size: response.data.byteLength
    };
  } catch (error) {
    console.error(`Failed to fetch image ${imageId}:`, error.message);
    throw new Error(`Image service unavailable or image not found: ${imageId}`);
  }
}

async function isImageServiceAvailable() {
  try {
    await axios.get(`${IMAGE_SERVICE_URL}/image/health-check`, {
      timeout: 3000,
      validateStatus: () => true
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function processReceiptOCR(imageData, imageId) {
async function processReceiptOCR(imageData, imageId) {
  try {
    await new Promise(resolve => setTimeout(resolve, 2000));

    const mockResults = [
      {
        store_name: "CVS Pharmacy",
        amount: "24.99",
        date: "2024-08-07",
        line_items: [
          { description: "Advil Pain Reliever", price: "12.99" },
          { description: "Band-Aid Bandages", price: "8.99" },
          { description: "Tax", price: "3.01" }
        ],
        confidence_scores: {
          store_name: 0.92,
          amount: 0.95,
          date: 0.88,
          overall: 0.91
        }
      },
      {
        store_name: "Walgreens",
        amount: "18.47",
        date: "2024-08-06",
        line_items: [
          { description: "Prescription Medication", price: "15.00" },
          { description: "Tax", price: "3.47" }
        ],
        confidence_scores: {
          store_name: 0.89,
          amount: 0.93,
          date: 0.85,
          overall: 0.89
        }
      },
      {
        store_name: "Target Pharmacy",
        amount: "67.43",
        date: "2024-08-05",
        line_items: [
          { description: "Vitamins", price: "29.99" },
          { description: "Thermometer", price: "32.99" },
          { description: "Tax", price: "4.45" }
        ],
        confidence_scores: {
          store_name: 0.94,
          amount: 0.96,
          date: 0.90,
          overall: 0.93
        }
      }
    ];

    const result = mockResults[Math.floor(Math.random() * mockResults.length)];

    result.processing_info = {
      image_id: imageId,
      image_size_bytes: imageData.byteLength,
      processing_time_ms: 2000,
      ocr_engine: "MockOCR v1.0",
      image_quality: "good",
      image_service_url: IMAGE_SERVICE_URL
    };

    return result;
  } catch (error) {
    throw new Error(`OCR processing failed: ${error.message}`);
  }
}
}

function validateExtractedData(data) {
  const errors = [];

  if (!data.store_name || data.store_name.trim().length < 2) {
    errors.push("Store name is required and must be at least 2 characters");
  }

  if (!data.amount || isNaN(parseFloat(data.amount)) || parseFloat(data.amount) <= 0) {
    errors.push("Amount must be a valid positive number");
  }

  if (!data.date || !isValidDate(data.date)) {
    errors.push("Date must be in valid format (YYYY-MM-DD)");
  }

  if (!data.confidence_scores || data.confidence_scores.overall < 0.5) {
    errors.push("OCR confidence too low for reliable extraction");
  }

  return errors;
}

function isValidDate(dateString) {
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date) && dateString.match(/^\d{4}-\d{2}-\d{2}$/);
}

// Routes
// Health check endpoint
app.get('/api/health', async (req, res) => {
  const imageServiceStatus = await isImageServiceAvailable();

  res.json({
    status: 'healthy',
    service: 'OCR Receipt Data Extraction',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    dependencies: {
      image_service: {
        url: IMAGE_SERVICE_URL,
        status: imageServiceStatus ? 'available' : 'unavailable'
      }
    },
    endpoints: [
      'POST /api/ocr/extract',
      'GET /api/ocr/formats',
      'GET /api/health'
    ]
  });
});

// Get supported file formats
app.get('/api/ocr/formats', (req, res) => {
  res.json({
    supported_formats: [
      {
        extension: '.jpg',
        mimetype: 'image/jpeg',
        max_size_mb: 10
      },
      {
        extension: '.jpeg',
        mimetype: 'image/jpeg',
        max_size_mb: 10
      },
      {
        extension: '.png',
        mimetype: 'image/png',
        max_size_mb: 10
      },
      {
        extension: '.pdf',
        mimetype: 'application/pdf',
        max_size_mb: 10
      }
    ],
    recommended_resolution: "300 DPI or higher",
    tips: [
      "Ensure receipt is well-lit and clearly visible",
      "Avoid shadows or reflections on the receipt",
      "Keep the receipt flat and straight",
      "Higher resolution images provide better OCR accuracy"
    ]
  });
});

// OCR extraction
app.post('/api/ocr/extract', async (req, res) => {
  try {
    const { image_id } = req.body;

    if (!image_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing image_id parameter',
        error_code: 'NO_IMAGE_ID',
        message: 'Please provide the image_id from the image upload service'
      });
    }

    console.log(`Processing receipt with image ID: ${image_id}`);

    if (!await isImageServiceAvailable()) {
      return res.status(503).json({
        success: false,
        error: 'Image service unavailable',
        error_code: 'IMAGE_SERVICE_DOWN',
        message: 'Cannot connect to image upload service'
      });
    }

    let imageData;
    try {
      imageData = await fetchImageFromService(image_id);
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: 'Image not found or fetch failed',
        error_code: 'IMAGE_FETCH_FAILED',
        message: error.message,
        image_id: image_id
      });
    }

    if (imageData.size > 10 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        error: 'Image too large',
        error_code: 'IMAGE_TOO_LARGE',
        max_size_mb: 10,
        actual_size_mb: (imageData.size / (1024 * 1024)).toFixed(2)
      });
    }

    const extractedData = await processReceiptOCR(imageData.data, image_id);

    const validationErrors = validateExtractedData(extractedData);

    if (validationErrors.length > 0) {
      return res.status(422).json({
        success: false,
        error: 'OCR data validation failed',
        error_code: 'VALIDATION_FAILED',
        validation_errors: validationErrors,
        raw_data: extractedData
      });
    }

    res.json({
      success: true,
      message: 'Receipt data extracted successfully',
      image_id: image_id,
      data: {
        store_name: extractedData.store_name,
        amount: parseFloat(extractedData.amount),
        receipt_date: extractedData.date,
        line_items: extractedData.line_items,
        suggested_category: determineMedicalCategory(extractedData.store_name, extractedData.line_items),
        confidence_scores: extractedData.confidence_scores,
        processing_info: extractedData.processing_info
      },
      recommendations: {
        review_required: extractedData.confidence_scores.overall < 0.85,
        fields_to_verify: getFieldsToVerify(extractedData.confidence_scores)
      }
    });

  } catch (error) {
    console.error('OCR processing error:', error);

    res.status(500).json({
      success: false,
      error: 'OCR processing failed',
      error_code: 'PROCESSING_ERROR',
      message: 'Please try again or contact support if the problem persists'
    });
  }
});

// Helper function to determine medical category based on store and items
function determineMedicalCategory(storeName, lineItems) {
  const storeNameLower = storeName.toLowerCase();
  const itemText = lineItems.map(item => item.description.toLowerCase()).join(' ');

  if (storeNameLower.includes('pharmacy') || storeNameLower.includes('cvs') ||
      storeNameLower.includes('walgreens') || storeNameLower.includes('rite aid')) {
    return 'Pharmacy';
  }

  if (storeNameLower.includes('dental') || storeNameLower.includes('orthodont') ||
      itemText.includes('dental') || itemText.includes('tooth')) {
    return 'Dental';
  }

  if (storeNameLower.includes('vision') || storeNameLower.includes('eye') ||
      storeNameLower.includes('optical') || itemText.includes('glasses') ||
      itemText.includes('contact')) {
    return 'Vision';
  }

  if (storeNameLower.includes('dr.') || storeNameLower.includes('doctor') ||
      storeNameLower.includes('clinic') || storeNameLower.includes('medical')) {
    return 'Doctor Visit';
  }

  if (itemText.includes('thermometer') || itemText.includes('bandage') ||
      itemText.includes('medical device') || itemText.includes('monitor')) {
    return 'Medical Device';
  }

  return 'Other';
}

function getFieldsToVerify(confidenceScores) {
  const fieldsToVerify = [];
  const threshold = 0.85;

  if (confidenceScores.store_name < threshold) {
    fieldsToVerify.push('store_name');
  }
  if (confidenceScores.amount < threshold) {
    fieldsToVerify.push('amount');
  }
  if (confidenceScores.date < threshold) {
    fieldsToVerify.push('date');
  }

  return fieldsToVerify;
}

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    error_code: 'INTERNAL_ERROR'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    error_code: 'NOT_FOUND',
    available_endpoints: [
      'POST /api/ocr/extract',
      'GET /api/ocr/formats',
      'GET /api/health'
    ]
  });
});

app.listen(PORT, () => {
  console.log(`OCR Receipt Data Extraction Microservice running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Supported formats: http://localhost:${PORT}/api/ocr/formats`);
  console.log(`Main endpoint: POST http://localhost:${PORT}/api/ocr/extract`);
  console.log(`Image service URL: ${IMAGE_SERVICE_URL}`);
  console.log(`Usage: Send POST request with {"image_id": "your-image-id"} to extract receipt data`);
});

module.exports = app;