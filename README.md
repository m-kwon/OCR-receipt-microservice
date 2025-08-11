# OCR Receipt Microservice

A Node.js microservice for extracting text from receipt images and PDF documents using Tesseract.js OCR technology.

## Features

- **Text Extraction**: Extract text from JPEG, PNG, and PDF files
- **Image Preprocessing**: Automatic image enhancement for better OCR accuracy
- **Multiple Input Methods**: Direct file upload or fetch from image service by ID
- **Real-time Processing**: Fast OCR processing with performance metrics
- **Health Monitoring**: Built-in health check and service status endpoints
- **Error Handling**: Comprehensive error responses with detailed messages

## Quick Start

### Prerequisites

- Node.js 16+
- npm or yarn package manager

### Installation

```bash
# Clone or download the microservice
cd OCR-receipt-microservice

# Install dependencies
npm install

# Start the service
npm start
```

The service will start on `http://localhost:5002` by default.

### Basic Usage

**Upload and extract text from a file:**
```bash
curl -X POST \
  -F "file=@receipt.jpg" \
  http://localhost:5002/ocr/extract
```

**Check service health:**
```bash
curl http://localhost:5002/health
```

## API Endpoints

### POST /ocr/extract
Extract text from uploaded file.

**Request:**
- Method: `POST`
- Content-Type: `multipart/form-data`
- Body: File upload with key `file`

**Supported formats:** JPEG, PNG, PDF (max 10MB)

**Response:**
```json
{
  "success": true,
  "message": "Text extracted successfully",
  "data": {
    "text": "CVS PHARMACY 123 MAIN ST...",
    "original_filename": "receipt.jpg",
    "file_type": "image/jpeg",
    "processing_time_ms": 3250,
    "text_length": 342,
    "timestamp": "2024-08-10T15:30:45.123Z"
  }
}
```

### POST /ocr/extract-by-id
Extract text from image stored in external image service.

**Request:**
```json
{
  "image_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Text extracted successfully",
  "data": {
    "text": "CVS PHARMACY 123 MAIN ST...",
    "image_id": "550e8400-e29b-41d4-a716-446655440000",
    "file_type": "image/jpeg",
    "processing_time_ms": 2890,
    "text_length": 342,
    "timestamp": "2024-08-10T15:30:45.123Z"
  }
}
```

### GET /health
Service health check and status information.

**Response:**
```json
{
  "service": "OCR Microservice",
  "status": "healthy",
  "version": "1.0.0",
  "supported_formats": ["JPEG", "PNG", "PDF"],
  "timestamp": "2024-08-10T15:30:45.123Z"
}
```

### GET /ocr/formats
Get detailed information about supported file formats.

**Response:**
```json
{
  "supported_formats": [
    {
      "type": "JPEG",
      "mime_types": ["image/jpeg", "image/jpg"],
      "description": "JPEG image files"
    }
  ],
  "max_file_size": "10MB",
  "processing_engine": "Tesseract.js for images, pdf-parse for PDFs"
}
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Service port | `5002` |
| `IMAGE_SERVICE_URL` | External image service URL | `http://localhost:5001` |

### Example Configuration

```bash
# Set custom port
export PORT=3000

# Set image service location
export IMAGE_SERVICE_URL=https://images.myapp.com

# Start service
npm start
```

## Integration with Image Service

This microservice can fetch images from an external image upload service:

```javascript
// Your image service should provide:
// GET /image/{id} - Returns image file by UUID

// OCR service will call:
const imageUrl = `${IMAGE_SERVICE_URL}/image/${image_id}`;
```

### Common Issues

**Service won't start:**
- Check Node.js version (16+ required)
- Verify all dependencies installed: `npm install`
- Check port availability

**Poor OCR accuracy:**
- Ensure images are well-lit and high contrast
- Try preprocessing images manually
- Check supported formats: JPEG, PNG work best

**Memory issues:**
- Large files (near 10MB) may cause memory spikes
- Consider reducing file size limits for production

## Integration Example

Example integration with a healthcare expense app:

```javascript
// Frontend: Upload receipt image
const uploadReceipt = async (imageFile) => {
  // 1. Upload to image service
  const formData = new FormData();
  formData.append('image', imageFile);
  const uploadResponse = await fetch('http://localhost:5001/upload', {
    method: 'POST',
    body: formData
  });
  const { id: imageId } = await uploadResponse.json();

  // 2. Extract text via OCR service
  const ocrResponse = await fetch('http://localhost:5002/ocr/extract-by-id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_id: imageId })
  });
  const { data } = await ocrResponse.json();

  // 3. Parse receipt data
  return {
    imageId,
    extractedText: data.text,
    processingTime: data.processing_time_ms
  };
};
```

## License

MIT License