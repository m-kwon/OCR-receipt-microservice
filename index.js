const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const pdf = require('pdf-parse');
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5002;

app.use(cors());
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'application/pdf'
    ];

    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and PDF files are allowed'));
    }
  }
});

app.get('/health', (req, res) => {
  res.json({
    service: 'OCR Microservice',
    status: 'healthy',
    version: '1.0.0',
    supported_formats: ['JPEG', 'PNG', 'PDF'],
    timestamp: new Date().toISOString()
  });
});

async function preprocessImage(buffer) {
  try {
    return await sharp(buffer)
      .greyscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();
  } catch (error) {
    console.error('Image preprocessing error:', error);
    return buffer;
  }
}

async function extractTextFromImage(buffer) {
  try {
    const processedBuffer = await preprocessImage(buffer);

    const { data: { text } } = await Tesseract.recognize(processedBuffer, 'eng', {
      logger: m => console.log(m)
    });

    return text.trim();
  } catch (error) {
    console.error('Tesseract OCR error:', error);
    throw new Error('Failed to extract text from image');
  }
}

async function extractTextFromPDF(buffer) {
  try {
    const data = await pdf(buffer);
    return data.text.trim();
  } catch (error) {
    console.error('PDF parsing error:', error);
    throw new Error('Failed to extract text from PDF');
  }
}

// Main OCR endpoint
app.post('/ocr/extract', upload.single('file'), async (req, res) => {
  const startTime = Date.now();

  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No file provided',
        details: 'Please upload a JPEG, PNG, or PDF file'
      });
    }

    const { buffer, mimetype, originalname } = req.file;
    let extractedText = '';

    console.log(`Processing file: ${originalname} (${mimetype})`);

    if (mimetype === 'application/pdf') {
      extractedText = await extractTextFromPDF(buffer);
    } else if (mimetype.startsWith('image/')) {
      extractedText = await extractTextFromImage(buffer);
    } else {
      return res.status(400).json({
        error: 'Unsupported file type',
        details: 'Only JPEG, PNG, and PDF files are supported'
      });
    }

    const processingTime = Date.now() - startTime;

    const cleanedText = extractedText
      .replace(/\n+/g, ' ') // Replace multiple newlines with single space
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .trim(); // Remove leading/trailing whitespace

    console.log(`OCR completed in ${processingTime}ms`);
    console.log(`Extracted text length: ${cleanedText.length} characters`);

    res.json({
      success: true,
      message: 'Text extracted successfully',
      data: {
        text: cleanedText,
        original_filename: originalname,
        file_type: mimetype,
        processing_time_ms: processingTime,
        text_length: cleanedText.length,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('OCR extraction error:', error);

    const processingTime = Date.now() - startTime;

    res.status(500).json({
      success: false,
      error: 'OCR extraction failed',
      details: error.message,
      processing_time_ms: processingTime,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/ocr/extract-by-id', async (req, res) => {
  const startTime = Date.now();

  try {
    const { image_id } = req.body;

    if (!image_id) {
      return res.status(400).json({
        error: 'No image ID provided',
        details: 'Please provide an image_id from the image service'
      });
    }

    const imageServiceUrl = process.env.IMAGE_SERVICE_URL || 'http://localhost:5001';
    const imageUrl = `${imageServiceUrl}/image/${image_id}`;

    console.log(`Fetching image from: ${imageUrl}`);

    const fetch = (await import('node-fetch')).default;
    const response = await fetch(imageUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    let extractedText = '';

    if (contentType === 'application/pdf') {
      extractedText = await extractTextFromPDF(buffer);
    } else if (contentType.startsWith('image/')) {
      extractedText = await extractTextFromImage(buffer);
    } else {
      return res.status(400).json({
        error: 'Unsupported file type',
        details: 'Only JPEG, PNG, and PDF files are supported'
      });
    }

    const processingTime = Date.now() - startTime;

    const cleanedText = extractedText
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    console.log(`OCR completed in ${processingTime}ms for image ID: ${image_id}`);

    res.json({
      success: true,
      message: 'Text extracted successfully',
      data: {
        text: cleanedText,
        image_id: image_id,
        file_type: contentType,
        processing_time_ms: processingTime,
        text_length: cleanedText.length,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('OCR extraction error:', error);

    const processingTime = Date.now() - startTime;

    res.status(500).json({
      success: false,
      error: 'OCR extraction failed',
      details: error.message,
      processing_time_ms: processingTime,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/ocr/formats', (req, res) => {
  res.json({
    supported_formats: [
      {
        type: 'JPEG',
        mime_types: ['image/jpeg', 'image/jpg'],
        description: 'JPEG image files'
      },
      {
        type: 'PNG',
        mime_types: ['image/png'],
        description: 'PNG image files'
      },
      {
        type: 'PDF',
        mime_types: ['application/pdf'],
        description: 'PDF documents (text will be extracted)'
      }
    ],
    max_file_size: '10MB',
    processing_engine: 'Tesseract.js for images, pdf-parse for PDFs'
  });
});

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File too large',
        details: 'Maximum file size is 10MB'
      });
    }
  }

  res.status(500).json({
    error: 'Internal server error',
    details: error.message
  });
});

app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    available_endpoints: [
      'GET /health',
      'POST /ocr/extract',
      'POST /ocr/extract-by-id',
      'GET /ocr/formats'
    ]
  });
});

app.listen(PORT, () => {
  console.log(`OCR Microservice running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`OCR endpoint: http://localhost:${PORT}/ocr/extract`);
  console.log('Supported formats: JPEG, PNG, PDF');
});

module.exports = app;