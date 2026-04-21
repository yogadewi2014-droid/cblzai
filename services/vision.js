const vision = require('@google-cloud/vision');
const config = require('../config');
const logger = require('../utils/logger');

let client;
if (config.googleVisionKeyFile) {
    client = new vision.ImageAnnotatorClient({ keyFilename: config.googleVisionKeyFile });
} else {
    client = new vision.ImageAnnotatorClient(); // uses GOOGLE_APPLICATION_CREDENTIALS env var
}

async function extractTextFromImage(imageBuffer) {
    try {
        const [result] = await client.textDetection({ image: { content: imageBuffer } });
        const detections = result.textAnnotations;
        if (detections && detections.length > 0) {
            return detections[0].description;
        }
        return '';
    } catch (error) {
        logger.error('Google Vision OCR error:', error);
        throw error;
    }
}

module.exports = { extractTextFromImage };
