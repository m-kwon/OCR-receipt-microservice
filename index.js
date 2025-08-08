require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const Tesseract = require('tesseract.js');
const axios = require('axios');
const sharp = require('sharp');
const winston = require('winston');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5003;

const IMAGE_SERVICE_URL = process.env.IMAGE_SERVICE_URL || 'http://localhost:5001';
const MAX_IMAGE_SIZE = parseInt(process.env.MAX_IMAGE_SIZE) || 10 * 1024 * 1024;
const OCR_TIMEOUT = parseInt(process.env.OCR_TIMEOUT) || 30000;
const TEMP_DIR = path.join(__dirname, 'temp');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ filename: 'ocr-service.log' })
  ]
});

app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

async function ensureTempDir() {
  try {
    await fs.access(TEMP_DIR);
  } catch {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  }
}

async function preprocessImage(imageBuffer) {
  try {
    const processedBuffer = await sharp(imageBuffer)
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .grayscale()
      .normalize()
      .sharpen({ sigma: 1, flat: 1, jagged: 2 })
      .png()
      .toBuffer();

    logger.debug(`Image preprocessed: ${imageBuffer.length} -> ${processedBuffer.length} bytes`);
    return processedBuffer;
  } catch (error) {
    logger.warn(`Image preprocessing failed: ${error.message}`);
    return imageBuffer;
  }
}

// Fetch image image-microservice
async function fetchImageFromService(imageId) {
  try {
    logger.info(`Fetching image ${imageId} from image service`);

    const response = await axios.get(`${IMAGE_SERVICE_URL}/image/${imageId}`, {
      responseType: 'arraybuffer',
      timeout: 10000,
      maxContentLength: MAX_IMAGE_SIZE
    });

    const imageBuffer = Buffer.from(response.data);

    const contentType = response.headers['content-type'] || '';
    let extension = '.jpg';
    if (contentType.includes('png')) extension = '.png';
    else if (contentType.includes('pdf')) extension = '.pdf';
    else if (contentType.includes('jpeg') || contentType.includes('jpg')) extension = '.jpg';

    logger.info(`Image fetched successfully: ${imageBuffer.length} bytes, type: ${contentType}`);

    return {
      buffer: imageBuffer,
      extension: extension,
      size: imageBuffer.length,
      contentType: contentType
    };
  } catch (error) {
    logger.error(`Failed to fetch image ${imageId}: ${error.message}`);
    throw new Error(`Image service unavailable or image not found: ${imageId}`);
  }
}

async function processReceiptOCR(imageBuffer, imageId) {
  const startTime = Date.now();
  let worker = null;

  try {
    logger.info(`Starting OCR processing for image ${imageId}`);

    const processedBuffer = await preprocessImage(imageBuffer);

    worker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          logger.debug(`OCR Progress: ${Math.round(m.progress * 100)}%`);
        }
      }
    });

    await worker.setParameters({
      tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz$.,/- :()[]',
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
      preserve_interword_spaces: '1',
      tessedit_do_invert: '0'
    });

    const ocrPromise = worker.recognize(processedBuffer);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('OCR timeout')), OCR_TIMEOUT)
    );

    const { data } = await Promise.race([ocrPromise, timeoutPromise]);

    const processingTime = Date.now() - startTime;
    logger.info(`OCR completed in ${processingTime}ms with confidence ${data.confidence.toFixed(2)}%`);

    const extractedData = parseReceiptText(data.text, data.confidence);

    extractedData.processing_info = {
      image_id: imageId,
      image_size_bytes: imageBuffer.length,
      processing_time_ms: processingTime,
      ocr_engine: "Tesseract.js v4.1.4",
      raw_text: data.text,
      raw_confidence: data.confidence,
      character_count: data.text.length,
      word_count: data.words ? data.words.length : 0,
      image_quality: classifyImageQuality(data.confidence),
      preprocessing_applied: true
    };

    return extractedData;

  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error(`OCR processing failed for image ${imageId} after ${processingTime}ms: ${error.message}`);
    throw new Error(`OCR processing failed: ${error.message}`);
  } finally {
    if (worker) {
      await worker.terminate();
    }
  }
}

function parseReceiptText(text, overallConfidence) {
  logger.debug(`Parsing OCR text: ${text.substring(0, 100)}...`);

  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  let extractedData = {
    store_name: '',
    amount: '',
    date: '',
    line_items: [],
    confidence_scores: {
      store_name: 0,
      amount: 0,
      date: 0,
      overall: Math.max(0, Math.min(1, overallConfidence / 100))
    }
  };

  const storeName = extractStoreName(lines);
  if (storeName.value) {
    extractedData.store_name = storeName.value;
    extractedData.confidence_scores.store_name = storeName.confidence;
  }

  const amount = extractAmount(lines);
  if (amount.value) {
    extractedData.amount = amount.value;
    extractedData.confidence_scores.amount = amount.confidence;
  }

  const date = extractDate(lines);
  if (date.value) {
    extractedData.date = date.value;
    extractedData.confidence_scores.date = date.confidence;
  }

  extractedData.line_items = extractLineItems(lines);

  logger.info(`Parsed data - Store: ${extractedData.store_name}, Amount: ${extractedData.amount}, Date: ${extractedData.date}, Items: ${extractedData.line_items.length}`);

  return extractedData;
}

function extractStoreName(lines) {
  const storePatterns = [
    /^(CVS|WALGREENS|WALMART|TARGET|COSTCO|RITE\s*AID|PHARMACY)/i,
    /^([A-Z][A-Z\s]{3,25})\s*(PHARMACY|STORE|MARKET|CLINIC)/i,
    /^(DR\.?\s+[A-Z][A-Z\s]{3,25})/i,
    /^([A-Z&][A-Z\s&]{4,30})\s*$/i
  ];

  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const line = lines[i].trim();

    for (const pattern of storePatterns) {
      const match = line.match(pattern);
      if (match) {
        const storeName = match[1] || match[0];
        return {
          value: cleanStoreName(storeName),
          confidence: 0.7 + (0.3 * (5 - i) / 5)
        };
      }
    }
  }

  const firstLine = lines.find(line => line.length > 3 && line.length < 50 && /[A-Za-z]/.test(line));
  return {
    value: firstLine ? cleanStoreName(firstLine) : '',
    confidence: firstLine ? 0.3 : 0
  };
}

function extractAmount(lines) {
  const amountPatterns = [
    /(?:TOTAL|AMOUNT|BALANCE)[:\s]*\$?(\d+\.?\d{0,2})/i,
    /^\s*\$?(\d+\.\d{2})\s*$/,
    /\$(\d+\.\d{2})\s*(?:TOTAL|AMOUNT|BALANCE)?/i,
    /(\d+\.\d{2})\s*(?:TOTAL|AMOUNT|BALANCE)/i
  ];

  let bestMatch = { value: '', confidence: 0 };

  lines.forEach((line, index) => {
    amountPatterns.forEach(pattern => {
      const match = line.match(pattern);
      if (match) {
        const amount = parseFloat(match[1]);
        if (amount > 0 && amount < 10000) {
          let confidence = 0.5;

          if (line.toLowerCase().includes('total')) confidence += 0.3;
          if (line.toLowerCase().includes('amount')) confidence += 0.2;
          if (line.toLowerCase().includes('balance')) confidence += 0.15;

          if (index > lines.length * 0.6) confidence += 0.2;

          if (match[1].includes('.')) confidence += 0.1;

          if (confidence > bestMatch.confidence) {
            bestMatch = {
              value: amount.toFixed(2),
              confidence: Math.min(confidence, 0.95)
            };
          }
        }
      }
    });
  });

  return bestMatch;
}

function extractDate(lines) {
  const datePatterns = [
    /(\d{1,2}\/\d{1,2}\/\d{4})/,
    /(\d{1,2}-\d{1,2}-\d{4})/,
    /(\d{4}-\d{1,2}-\d{1,2})/,
    /((?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?\s+\d{1,2},?\s+\d{4})/i,
    /(\d{1,2}\s+(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?\s+\d{4})/i
  ];

  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const line = lines[i];

    for (const pattern of datePatterns) {
      const match = line.match(pattern);
      if (match) {
        const dateStr = match[1];
        const parsedDate = parseAndFormatDate(dateStr);

        if (parsedDate) {
          return {
            value: parsedDate,
            confidence: 0.8 - (i * 0.03)
          };
        }
      }
    }
  }

  return {
    value: new Date().toISOString().split('T')[0],
    confidence: 0.1
  };
}

function extractLineItems(lines) {
  const lineItems = [];
  const itemPatterns = [
    /^(.+?)\s+\$?(\d+\.?\d{0,2})$/,
    /^(.+?)\s+(\d+\.\d{2})$/,
    /^(.+)\s+\$(\d+\.\d{2})$/
  ];

  const excludePatterns = /^(total|subtotal|tax|amount|balance|change|cash|card|visa|mastercard|debit|credit|thank|receipt|store|pharmacy|date|time)/i;

  lines.forEach(line => {
    if (excludePatterns.test(line) || line.length < 3 || line.length > 60) {
      return;
    }

    for (const pattern of itemPatterns) {
      const match = line.match(pattern);
      if (match) {
        const description = match[1].trim();
        const price = parseFloat(match[2]);

        if (description.length > 2 && price > 0 && price < 1000) {
          lineItems.push({
            description: cleanItemDescription(description),
            price: price.toFixed(2)
          });
          break;
        }
      }
    }
  });

  return lineItems.slice(0, 15);
}

function cleanStoreName(name) {
  return name
    .replace(/[^A-Za-z0-9\s&\-.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function cleanItemDescription(description) {
  return description
    .replace(/[^A-Za-z0-9\s\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAndFormatDate(dateStr) {
  try {
    let date;

    if (dateStr.match(/^\d{4}-\d{1,2}-\d{1,2}$/)) {
      date = new Date(dateStr);
    } else if (dateStr.match(/^\d{1,2}\/\d{1,2}\/\d{4}$/)) {
      const [month, day, year] = dateStr.split('/');
      date = new Date(year, month - 1, day);
    } else if (dateStr.match(/^\d{1,2}-\d{1,2}-\d{4}$/)) {
      const [month, day, year] = dateStr.split('-');
      date = new Date(year, month - 1, day);
    } else {
      date = new Date(dateStr);
    }

    const now = new Date();
    const twoYearsAgo = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());

    if (date >= twoYearsAgo && date <= now) {
      return date.toISOString().split('T')[0];
    }

    return null;
  } catch (error) {
    return null;
  }
}

function classifyImageQuality(confidence) {
  if (confidence >= 80) return 'excellent';
  if (confidence >= 65) return 'good';
  if (confidence >= 45) return 'fair';
  if (confidence >= 25) return 'poor';
  return 'very_poor';
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

  if (!data.confidence_scores || data.confidence_scores.overall < 0.2) {
    errors.push("OCR confidence too low for reliable extraction");
  }

  return errors;
}

function isValidDate(dateString) {
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date) && dateString.match(/^\d{4}-\d{2}-\d{2}$/);
}

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

// Routes
app.get('/api/health', async (req, res) => {
  const imageServiceStatus = await isImageServiceAvailable();

  res.json({
    status: 'healthy',
    service: 'OCR Receipt Data Extraction (Tesseract.js)',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    dependencies: {
      image_service: {
        url: IMAGE_SERVICE_URL,
        status: imageServiceStatus ? 'available' : 'unavailable'
      },
      tesseract: {
        version: "4.1.4",
        status: 'available'
      }
    },
    configuration: {
      max_image_size_mb: MAX_IMAGE_SIZE / (1024 * 1024),
      ocr_timeout_seconds: OCR_TIMEOUT / 1000,
      preprocessing_enabled: true
    },
    endpoints: [
      'POST /api/ocr/extract',
      'GET /api/ocr/formats',
      'GET /api/health',
      'GET /api/metrics'
    ]
  });
});

app.get('/api/ocr/formats', (req, res) => {
  res.json({
    supported_formats: [
      {
        extension: '.jpg',
        mimetype: 'image/jpeg',
        max_size_mb: MAX_IMAGE_SIZE / (1024 * 1024),
        recommended: true
      },
      {
        extension: '.jpeg',
        mimetype: 'image/jpeg',
        max_size_mb: MAX_IMAGE_SIZE / (1024 * 1024),
        recommended: true
      },
      {
        extension: '.png',
        mimetype: 'image/png',
        max_size_mb: MAX_IMAGE_SIZE / (1024 * 1024),
        recommended: true
      },
      {
        extension: '.pdf',
        mimetype: 'application/pdf',
        max_size_mb: MAX_IMAGE_SIZE / (1024 * 1024),
        recommended: false,
        note: "PDF support limited to single-page documents"
      }
    ],
    optimization_tips: [
      "Use high resolution images (300 DPI or higher)",
      "Ensure good lighting with minimal shadows",
      "Keep receipt flat and straight",
      "Avoid blurry or tilted images",
      "Use JPEG or PNG format for best results"
    ],
    processing_info: {
      average_processing_time: "5-15 seconds",
      accuracy_range: "70-95% depending on image quality",
      preprocessing_applied: "grayscale, normalization, sharpening"
    }
  });
});

app.post('/api/ocr/extract', async (req, res) => {
  const requestId = Date.now().toString();
  logger.info(`[${requestId}] OCR request received`);

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

    logger.info(`[${requestId}] Processing receipt with image ID: ${image_id}`);

    if (!await isImageServiceAvailable()) {
      return res.status(503).json({
        success: false,
        error: 'Image service unavailable',
        error_code: 'IMAGE_SERVICE_DOWN',
        message: 'Cannot connect to image upload service',
        retry_after: 30
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

    if (imageData.size > MAX_IMAGE_SIZE) {
      return res.status(400).json({
        success: false,
        error: 'Image too large',
        error_code: 'IMAGE_TOO_LARGE',
        max_size_mb: MAX_IMAGE_SIZE / (1024 * 1024),
        actual_size_mb: (imageData.size / (1024 * 1024)).toFixed(2)
      });
    }

    const extractedData = await processReceiptOCR(imageData.buffer, image_id);

    const validationErrors = validateExtractedData(extractedData);

    if (validationErrors.length > 0) {
      return res.status(422).json({
        success: false,
        error: 'OCR data validation failed',
        error_code: 'VALIDATION_FAILED',
        validation_errors: validationErrors,
        raw_data: extractedData,
        suggestions: [
          "Try uploading a clearer image",
          "Ensure the receipt is well-lit and flat",
          "Check that the text is clearly visible"
        ]
      });
    }

    logger.info(`[${requestId}] OCR processing completed successfully`);

    res.json({
      success: true,
      message: 'Receipt data extracted successfully',
      request_id: requestId,
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
        review_required: extractedData.confidence_scores.overall < 0.75,
        fields_to_verify: getFieldsToVerify(extractedData.confidence_scores),
        confidence_level: extractedData.processing_info.image_quality
      }
    });

  } catch (error) {
    logger.error(`[${requestId}] OCR processing error: ${error.message}`, error);

    res.status(500).json({
      success: false,
      error: 'OCR processing failed',
      error_code: 'PROCESSING_ERROR',
      message: 'Please try again with a clearer image or contact support if the problem persists',
      request_id: requestId
    });
  }
});

app.get('/api/metrics', (req, res) => {
  res.json({
    service_name: 'OCR Receipt Extraction',
    uptime_seconds: process.uptime(),
    memory_usage: process.memoryUsage(),
    node_version: process.version,
    timestamp: new Date().toISOString()
  });
});

function getFieldsToVerify(confidenceScores) {
  const fieldsToVerify = [];
  const threshold = 0.7;

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
  logger.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    error_code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred'
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    error_code: 'NOT_FOUND',
    available_endpoints: [
      'POST /api/ocr/extract',
      'GET /api/ocr/formats',
      'GET /api/health',
      'GET /api/metrics'
    ]
  });
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

async function startServer() {
  try {
    await ensureTempDir();

    app.listen(PORT, () => {
      logger.info(`Real OCR Receipt Data Extraction Microservice running on port ${PORT}`);
      logger.info(`Health check: http://localhost:${PORT}/api/health`);
      logger.info(`Supported formats: http://localhost:${PORT}/api/ocr/formats`);
      logger.info(`Main endpoint: POST http://localhost:${PORT}/api/ocr/extract`);
      logger.info(`Image service URL: ${IMAGE_SERVICE_URL}`);
      logger.info(`Using Tesseract.js for real OCR processing`);
      logger.info(`Usage: Send POST request with {"image_id": "your-image-id"} to extract receipt data`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;