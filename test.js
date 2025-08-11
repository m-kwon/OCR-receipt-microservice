// ocr-microservice/test.js
const fs = require('fs');
const path = require('path');

const OCR_SERVICE_URL = 'http://localhost:5002';

async function testOCRService() {
  console.log('🧪 Testing OCR Microservice');
  console.log('=====================================\n');

  try {
    // Test 1: Health Check
    console.log('1. Health Check Test');
    console.log('-------------------');

    const fetch = (await import('node-fetch')).default;
    const FormData = (await import('form-data')).default;

    const healthResponse = await fetch(`${OCR_SERVICE_URL}/health`);
    const healthData = await healthResponse.json();

    console.log('Health check:', healthData.status);
    console.log('Supported formats:', healthData.supported_formats.join(', '));
    console.log();

    // Test 2: Get Formats
    console.log('2. Supported Formats Test');
    console.log('-------------------------');

    const formatsResponse = await fetch(`${OCR_SERVICE_URL}/ocr/formats`);
    const formatsData = await formatsResponse.json();

    console.log('Available formats:');
    formatsData.supported_formats.forEach(format => {
      console.log(`   - ${format.type}: ${format.description}`);
    });
    console.log(`Max file size: ${formatsData.max_file_size}`);
    console.log();

    console.log('3. OCR Text Extraction Test');
    console.log('---------------------------');

    console.log('To test with a real image:');
    console.log('   1. Place a receipt image in the same directory as this test file');
    console.log('   2. Name it "test-receipt.jpg" or "test-receipt.png"');
    console.log('   3. Run this test again');
    console.log();

    const testImagePath = path.join(__dirname, 'test-receipt.jpg');
    const testImagePngPath = path.join(__dirname, 'test-receipt.png');

    let imagePath = null;
    if (fs.existsSync(testImagePath)) {
      imagePath = testImagePath;
    } else if (fs.existsSync(testImagePngPath)) {
      imagePath = testImagePngPath;
    }

    if (imagePath) {
      console.log(`Testing with image: ${path.basename(imagePath)}`);

      const formData = new FormData();
      formData.append('file', fs.createReadStream(imagePath));

      const ocrResponse = await fetch(`${OCR_SERVICE_URL}/ocr/extract`, {
        method: 'POST',
        body: formData
      });

      const ocrData = await ocrResponse.json();

      if (ocrData.success) {
        console.log('OCR extraction successful!');
        console.log(`⏱Processing time: ${ocrData.data.processing_time_ms}ms`);
        console.log(`Text length: ${ocrData.data.text_length} characters`);
        console.log('Extracted text preview:');
        console.log('   ' + ocrData.data.text.substring(0, 200) + '...');
      } else {
        console.log('OCR extraction failed:', ocrData.error);
      }
    } else {
      console.log('No test image found. Skipping OCR test.');
      console.log('Add test-receipt.jpg or test-receipt.png to test OCR functionality.');
    }

    console.log();

    // Test 4: Test with image ID (requires image service)
    console.log('4. OCR by Image ID Test');
    console.log('----------------------');
    console.log('This test requires:');
    console.log('   1. Image service running on port 5001');
    console.log('   2. An uploaded image with known ID');
    console.log('   Use the extract-by-id endpoint with: {"image_id": "your-uuid-here"}');
    console.log();

    console.log();
    console.log('OCR Microservice testing complete!');
    console.log('=====================================');

  } catch (error) {
    console.error('Test failed:', error.message);
    console.log('\nMake sure:');
    console.log('   1. OCR service is running: npm start');
    console.log('   2. All dependencies are installed: npm install');
    console.log('   3. Port 5002 is available');
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  testOCRService();
}

module.exports = { testOCRService };